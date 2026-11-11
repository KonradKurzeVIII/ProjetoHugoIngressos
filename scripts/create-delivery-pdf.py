"""Generate the technical delivery document from measured test results."""

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, KeepTogether,
)

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "output" / "pdf" / "documento-entrega.pdf"
identity = json.loads((ROOT / "docs" / "identificacao.json").read_text("utf-8"))
results = json.loads((ROOT / "output" / "load-results.json").read_text("utf-8"))
blackbox_path = ROOT / "output" / "blackbox-load-results.json"
blackbox = json.loads(blackbox_path.read_text("utf-8")) if blackbox_path.exists() else None

INK = colors.HexColor("#172B4D")
BLUE = colors.HexColor("#18658A")
MUTED = colors.HexColor("#526375")
LIGHT = colors.HexColor("#E7F1F6")
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="CoverTitle", fontName="Helvetica-Bold", fontSize=28, leading=32,
    textColor=INK, spaceAfter=10,
))
styles.add(ParagraphStyle(
    name="SubtitleCustom", fontName="Helvetica", fontSize=13, leading=18,
    textColor=BLUE, spaceAfter=18,
))
styles.add(ParagraphStyle(
    name="SectionCustom", fontName="Helvetica-Bold", fontSize=13, leading=17,
    textColor=BLUE, spaceBefore=13, spaceAfter=7, keepWithNext=True,
))
styles.add(ParagraphStyle(
    name="BodyCustom", fontName="Helvetica", fontSize=10.2, leading=14.3,
    textColor=INK, spaceAfter=8, alignment=TA_LEFT,
))
styles.add(ParagraphStyle(
    name="NoticeCustom", parent=styles["BodyCustom"], backColor=LIGHT,
    borderPadding=10, spaceBefore=8, spaceAfter=14,
))
styles.add(ParagraphStyle(
    name="CodeCustom", fontName="Courier", fontSize=8.7, leading=12,
    textColor=INK, spaceAfter=6,
))


def paragraph(text, style="BodyCustom"):
    return Paragraph(text, styles[style])


def section(title, *texts):
    return [paragraph(title, "SectionCustom"), *[paragraph(text) for text in texts]]


def number(value):
    return f"{value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def footer(canvas, doc):
    width, height = A4
    canvas.saveState()
    canvas.setStrokeColor(LIGHT)
    canvas.line(19 * mm, 17 * mm, width - 19 * mm, 17 * mm)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(19 * mm, 12 * mm, "Ingresos API | Documento técnico de entrega")
    canvas.drawRightString(width - 19 * mm, 12 * mm, f"{doc.page}")
    canvas.restoreState()


author = identity.get("nome") or "Não informado pelo aluno"
repository = identity.get("repositorio") or "Ainda não publicado / URL não informada"
local_time = datetime.fromisoformat(results["generatedAt"]).astimezone(
    timezone(timedelta(hours=-3))
)
story = [
    paragraph(escape(identity["projeto"]), "CoverTitle"),
    paragraph("API sob alta demanda - projeto individual", "SubtitleCustom"),
    paragraph(f"<b>Nome do aluno:</b> {escape(author)}<br/>"
              f"<b>Repositório GitHub:</b> {escape(repository)}<br/>"
              f"<b>Ensaio principal:</b> {local_time:%d/%m/%Y às %H:%M} "
              "(America/Sao_Paulo)."),
]
if not identity.get("nome") or not identity.get("repositorio"):
    story.append(paragraph(
        "<b>Versão técnica com identificação pendente.</b> Preencher nome do aluno "
        "e URL real do GitHub em docs/identificacao.json e regenerar este PDF "
        "antes de enviá-lo ao classroom.", "NoticeCustom"))

story += section("1. Tecnologias e organização",
    "<b>Node.js 24, TypeScript, Fastify 5 e PostgreSQL 18.</b> O serviço HTTP "
    "usa JWT HS256; senhas usam scrypt assíncrono e salt aleatório. O banco "
    "guarda usuários, show e pedidos. A interface usa HTML, CSS e JavaScript "
    "locais, servidos pela API. Docker Compose reúne aplicação e banco, "
    "com volume persistente, healthchecks e porta 8080 publicada somente no localhost.",
    "<b>src/app.ts</b> concentra rotas, autenticação e validação. "
    "<b>src/orders.ts</b> concentra estados e cotas; <b>src/fifo.ts</b> ordena "
    "mutações. <b>src/database.ts</b> controla transações e conexões; "
    "<b>db/schema.sql</b> cria o schema e o índice parcial das reservas. "
    "A pasta public contém a interface; test contém integração HTTP/PostgreSQL "
    "e prova da fila.")
story += section("2. Endpoints e comportamento implementado",
    "<b>POST /auth/registrar</b>: recebe username/password; responde 201. "
    "<b>POST /auth/login</b>: responde 200 com token. Todas as rotas seguintes "
    "exigem Authorization: Bearer &lt;token&gt;.",
    "<b>POST /pedidos</b>: aceita showId 7; cria NO_CARRINHO e responde 201. "
    "<b>POST /pedidos/{id}/reservar</b>: responde 200 com RESERVADO e "
    "<b>X-Lote: 7F3A</b>; recusas usam 409 com POOL_CHEIO ou COTA_PESSOAL. "
    "A chave do corpo é sempre <b>error</b>, com a grafia exata do contrato.",
    "<b>POST /pedidos/{id}/cancelar</b>: responde 200 com CANCELADO e libera "
    "a vaga e a cota pessoal. <b>GET /pool</b>: retorna total, ocupadas e livres. "
    "Pedido alheio ou inexistente responde 404 nas duas mutações. "
    "O endpoint adicional público <b>GET /health</b> verifica acesso ao banco.",
    "<b>Aplicação web em http://localhost:8080:</b> cadastro, login, carrinho, "
    "reserva, cancelamento com confirmação e consulta da disponibilidade. "
    "O endpoint adicional autenticado <b>GET /pedidos</b> lista somente os "
    "pedidos da conta. Recarregar a página ou entrar novamente recupera o "
    "estado do banco, inclusive cancelamentos.")

story.append(PageBreak())
story += [paragraph("Concorrência e garantias", "CoverTitle")]
story += section("3. Estratégia escolhida",
    "Uma única instância admite reservas e cancelamentos em uma <b>fila FIFO "
    "comum</b>, depois de autenticar e validar a requisição. Chegada significa "
    "essa admissão no servidor, não o horário do clique nem a chegada de pacotes. "
    "A requisição aguardando na fila não mantém conexão nem transação aberta.",
    "Quando chega sua vez, a operação abre uma transação READ COMMITTED e "
    "executa <b>SELECT ... FOR NO KEY UPDATE</b> no show 7. Sob esse bloqueio, verifica "
    "proprietário, estado, quantidade global e quantidade pessoal. Só então "
    "atualiza o pedido. Confirma com COMMIT antes de responder; uma falha "
    "executa ROLLBACK. A conexão é liberada mesmo se houver erro.",
    "Reservas e cancelamentos sempre obtêm o mesmo bloqueio primeiro. Portanto, "
    "duas operações não podem decidir ao mesmo tempo com base na mesma vaga "
    "livre. A fila fornece ordem; o bloqueio e a transação fornecem atomicidade. "
    "Um lock de banco, isoladamente, não promete FIFO. O modo NO KEY UPDATE "
    "permite criar carrinhos sem esperar pela reserva, pois é compatível com "
    "o bloqueio da verificação de chave estrangeira.")
story += section("4. Invariantes e liberação",
    "O número de pedidos RESERVADO permanece entre <b>0 e 100</b>; cada usuário "
    "mantém <b>no máximo dois</b>. Carrinhos não ocupam vaga. A ocupação é "
    "derivada dos pedidos, sem contador de estoque duplicado. GET /pool usa "
    "uma única consulta e snapshot MVCC; ocupadas + livres é sempre 100.",
    "Repetir uma reserva confirmada retorna 200 e X-Lote sem ocupar outra vaga. "
    "Repetir um cancelamento confirmado retorna 200 sem liberar outra vaga. "
    "Somente RESERVADO pode mudar para CANCELADO. Cancelamento não apaga o "
    "registro e não permite reservar novamente esse mesmo pedido.")
story += section("5. Decisões complementares e espera",
    "O projeto tem apenas o show 7. Outros showId recebem 400. Estado "
    "incompatível recebe 409 com ESTADO_INVALIDO. Propriedade vem antes de "
    "estado e cotas. Para uma nova reserva, COTA_PESSOAL precede POOL_CHEIO "
    "quando ambos se aplicam. Credenciais e JWT inválidos recebem 401.",
    "A API desativa deadlines internos de processamento. O pool tem dez "
    "conexões, sem expirar a espera; statement_timeout e lock_timeout são zero. "
    "As transações são curtas, sem chamadas externas. Headers incompletos e "
    "sockets ociosos seguem os limites normais do Node. Falhas reais de "
    "infraestrutura não são disfarçadas como falta de ingresso.")

story.append(PageBreak())
story += [paragraph("Testes e estado da entrega", "CoverTitle")]
story += section("6. Como a aplicação foi testada",
    "Suíte automatizada com PostgreSQL real portátil e conexões HTTP locais, "
    "sem mocks de banco nem injeção HTTP do Fastify. Valida autenticação, "
    "propriedade, estados, header, limite pessoal, retries concorrentes, "
    "cancelamentos, rollback e limites globais com filas independentes. "
    "Também consulta o banco para verificar as invariantes. Os 14 testes "
    "automatizados incluem assets web, isolamento da listagem, criação de "
    "carrinho sem esperar pelo bloqueio e recuperação da fila após uma "
    "desconexão sem código do driver pg injetada de forma controlada.",
    "No ensaio principal, 1.000 usuários e carrinhos foram preparados por SQL; "
    "JWTs válidos foram assinados pela aplicação. Mil conexões HTTP foram "
    "estabelecidas gradualmente antes de disparar as reservas juntas. A "
    "medição exclui cadastro, login e abertura de conexão. Esse desenho mede "
    "requisições concorrentes, sem misturar uma rajada de handshakes TCP do Windows.")
story += [paragraph(
    f"<b>{results['concurrentReservations']} reservas simultâneas:</b> "
    f"{results['successful']} sucessos; {results['poolFull']} recusas POOL_CHEIO; "
    f"{results['unexpectedResponses']} respostas inesperadas; "
    f"{results['clientTimeouts']} timeouts.<br/>"
    f"<b>Latência:</b> p50 {number(results['latencyMs']['p50'])} ms; "
    f"p95 {number(results['latencyMs']['p95'])} ms; "
    f"p99 {number(results['latencyMs']['p99'])} ms.<br/>"
    f"<b>Vazão:</b> {number(results['requestsPerSecond'])} requisições/s. "
    f"<b>Pool:</b> {results['consistentPoolSnapshots']} leituras consistentes. "
    "FIFO de admissão e estado final no banco foram verificados.", "NoticeCustom")]
if blackbox:
    story.append(paragraph(
        f"Uma segunda carga externa cadastrou e autenticou usuários pelo HTTP "
        f"e executou {blackbox['concurrentReservations']} reservas simultâneas "
        f"contra o executável compilado: {blackbox['successful']} sucessos, "
        f"{blackbox['poolFull']} recusas, zero resposta inesperada e timeout. "
        "Ao final, cancelou suas reservas e confirmou 100 vagas livres."))
story.append(paragraph(
    "<b>Verificação no navegador:</b> cadastro, login com senha inválida, "
    "novo login, duas reservas, recusa da terceira mantendo o carrinho, "
    "confirmação de cancelamento e recuperação dos pedidos após recarregar. "
    "O layout foi inspecionado em desktop e nas larguras 390 e 320 pixels, "
    "sem rolagem horizontal."))
story += section("7. Reproduzir e apresentar",
    "<b>Entrega:</b> docker compose down -v; depois docker compose up --build -d. "
    "Acessar http://localhost:8080. O primeiro comando apaga os dados do volume.",
    "<b>Testes:</b> usar docker-compose.yml junto de docker-compose.test.yml "
    "e executar o serviço tests, conforme README. Para desenvolvimento com "
    "Node 24: npm ci, npm run typecheck, npm run build e npm test. "
    "O roteiro de cinco minutos está em docs/apresentacao.md.")
story += section("8. Limitações e pendências conhecidas",
    "FIFO global depende de uma instância. A fila pendente reside em memória "
    "e não sobrevive à queda da API; commits persistem e retries são seguros. "
    "A latência cresce com a fila. A evidência é limitada à carga executada: "
    "não garante ausência de falhas do sistema operacional ou recursos infinitos.",
    "Os manifestos foram validados pelo Docker Compose portátil, mas a "
    "execução das imagens ainda não foi verificada: o host não tem Docker "
    "Engine operacional. Nome do aluno e URL do GitHub estão identificados "
    "neste documento. O workflow de conformidade reproduz a validação em "
    "containers no GitHub Actions. O envio ao classroom é feito pelo aluno.")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
document = SimpleDocTemplate(
    str(OUTPUT), pagesize=A4, rightMargin=19 * mm, leftMargin=19 * mm,
    topMargin=18 * mm, bottomMargin=23 * mm,
    title=f"{identity['projeto']} - Documento de entrega",
    author=identity.get("nome") or identity["projeto"],
)
document.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUTPUT)
