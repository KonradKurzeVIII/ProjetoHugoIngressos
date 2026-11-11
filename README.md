# Ingresos API

Projeto individual de uma API de reserva de ingressos. O cenário é um show com
100 vagas e muita gente tentando reservar ao mesmo tempo. Cada usuário pode
manter até duas reservas.

Aluno: João Pedro Wanderley do Nascimento.

O projeto usa Node.js 24, TypeScript, Fastify 5 e PostgreSQL 18. Também tem uma
interface simples para criar conta, reservar e acompanhar os pedidos.

## Como rodar

É preciso ter Docker com Compose e suporte a containers Linux. Na raiz do projeto:

```sh
docker compose down -v
docker compose up --build -d
```

Depois, abra [localhost:8080](http://localhost:8080). O banco e o show 7 são
criados na inicialização; não precisa instalar Node.js ou PostgreSQL na máquina.

O comando `down -v` apaga os dados. Para parar sem apagar, use `docker compose down`.
Se precisar conferir a inicialização:

```sh
docker compose ps
docker compose logs api
```

## Como as reservas funcionam

Adicionar um pedido ao carrinho ainda não ocupa vaga. O fluxo é:

```text
NO_CARRINHO -> RESERVADO -> CANCELADO
```

Reservas e cancelamentos passam pela mesma fila FIFO. A ordem considerada é a
entrada nessa fila, depois da autenticação e da validação da requisição.
A aplicação foi montada para rodar com uma única instância.

Quando chega sua vez, a operação abre uma transação no PostgreSQL e bloqueia
o registro do show com `SELECT ... FOR NO KEY UPDATE`. Dentro da transação,
confere o dono do pedido, o estado atual, o total de reservas e a cota do usuário.
Só responde sucesso depois do commit. Se algo falhar, faz rollback e libera a conexão.

O cuidado principal é consultar as cotas e atualizar o pedido sob o mesmo
bloqueio. Assim, duas requisições não conseguem reservar a mesma última vaga.
O modo `NO KEY UPDATE` também permite criar novos carrinhos durante uma reserva,
sem fazer a verificação de chave estrangeira esperar por ela.

A ocupação vem da contagem dos pedidos em `RESERVADO`. Não existe um segundo
contador de estoque para manter sincronizado. O `GET /pool` calcula total,
ocupadas e livres em uma única consulta.

Somente cancelar uma reserva devolve a vaga. Sair da conta ou deixar de usar a
aplicação não cancela o ingresso. Repetir uma reserva que já está confirmada
não consome outra vaga. Repetir o cancelamento não devolve a vaga duas vezes.

A fila fica em memória: se a API cair, as requisições pendentes precisam ser
repetidas, mas os pedidos confirmados continuam no banco. Não há timeout interno
de processamento; um bloqueio externo mantido no banco pode prolongar a espera.

## Endpoints

Cadastro e login recebem o mesmo formato de body:

```json
{"username":"joao","password":"senha123"}
```

O cadastro retorna `201`; o login retorna `200` com `{"token":"..."}`.
As rotas de pedidos e pool exigem o header:

```http
Authorization: Bearer <token>
```

| Método | Rota | Uso |
| --- | --- | --- |
| POST | `/auth/registrar` | Criar uma conta |
| POST | `/auth/login` | Obter o token |
| POST | `/pedidos` | Criar um carrinho com `{"showId":7}` |
| POST | `/pedidos/{id}/reservar` | Reservar o ingresso |
| POST | `/pedidos/{id}/cancelar` | Cancelar a reserva |
| GET | `/pool` | Consultar as vagas |
| GET | `/pedidos` | Listar os pedidos da conta; usado pela interface |

A criação de pedido retorna `201` com `{"id":42,"status":"NO_CARRINHO"}`.
Reserva e cancelamento retornam `200` com o mesmo formato e o novo status.
Toda reserva com resposta `200` inclui `X-Lote: 7F3A`, inclusive nas repetições.

O pool retorna, por exemplo:

```json
{"total":100,"ocupadas":37,"livres":63}
```

Se não houver vaga, a reserva retorna `409 {"error":"POOL_CHEIO"}`.
Se o usuário já tiver duas reservas, retorna `409 {"error":"COTA_PESSOAL"}`.
O pedido continua no carrinho. Quando as duas condições se aplicam, a cota
pessoal tem prioridade.

Pedido de outro usuário ou inexistente retorna `404` nas duas operações.
Cancelar um carrinho ou tentar reservar um pedido cancelado retorna
`409 {"error":"ESTADO_INVALIDO"}`. Existe apenas o show 7; outros IDs recebem `400`.

Dados inválidos recebem `400 {"error":"DADOS_INVALIDOS"}`. Token ausente,
inválido ou expirado recebe `401 {"error":"NAO_AUTORIZADO"}`.
Nome de usuário repetido recebe `409 {"error":"USUARIO_EXISTENTE"}`.
Falhas reconhecidas de conexão com o banco recebem `503`; erros inesperados
recebem `500` e ficam registrados no log.

As senhas usam scrypt com salt aleatório. O JWT expira em duas horas. Para
manter os tokens válidos após reiniciar a API, configure um `JWT_SECRET` privado
com pelo menos 32 caracteres em `.env`, seguindo `.env.example`. Sem essa
configuração, um novo segredo é gerado a cada inicialização.

O endpoint público `GET /health` verifica a conexão com o banco.

## Testes

Para executar a suíte pelo Docker:

```sh
docker compose -f docker-compose.yml -f docker-compose.test.yml run --build --rm tests
```

São 14 testes, cobrindo autenticação, propriedade dos pedidos, estados, cotas,
repetições, cancelamentos, rollback e concorrência. Eles usam PostgreSQL real
em um schema separado, que é removido ao final. Um dos testes injeta uma
desconexão do driver para conferir a resposta e a recuperação da fila.

Na [execução pelo GitHub Actions em 11/11/2026](https://github.com/KonradKurzeVIII/ProjetoHugoIngressos/actions/runs/43113509505),
o build, a inicialização por Compose e os 14 testes passaram. Na carga de
1.000 tentativas houve 100 reservas, 900 recusas `POOL_CHEIO`, nenhuma resposta
inesperada e nenhum timeout. A latência p95 foi de 1.247,08 ms.

Essa carga usa usuários e carrinhos preparados por SQL, tokens válidos e
conexões HTTP abertas antes do disparo. Ela mede a disputa pelas reservas;
cadastro, login e abertura das conexões ficam fora da medição. O cliente de
teste tem um prazo total de 30 segundos para receber cada resposta.

Também há uma carga externa que cadastra 200 usuários pelo HTTP, cria dois
carrinhos por conta e disputa 400 reservas. Com a API em execução e o pool vazio:

```sh
docker compose -f docker-compose.yml -f docker-compose.test.yml run --build --rm -e BASE_URL=http://api:8080 tests npm run load
```

Esse teste cancela as próprias reservas ao terminar. As contas e os pedidos
ficam no banco; se ele for interrompido, algumas reservas podem continuar ativas.
Na execução registrada, foram 100 reservas e 300 recusas, sem timeout.

Os resultados estão em [output/](output/). O arquivo
[compose-verification.json](output/compose-verification.json) aponta para o
commit testado e a execução completa.

## Desenvolvimento local

Para desenvolver fora do Docker, é necessário Node.js 24:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run local
```

O `npm run local` inicia a API na porta 8080 e um PostgreSQL portátil na porta
54329. Os dados ficam em `.tools/`, fora do Git. Encerre com Ctrl+C.
O `npm test`, quando não recebe `TEST_DATABASE_URL`, usa um banco portátil
temporário. A entrega continua sendo pelo Compose.

## Onde está cada parte

- `src/app.ts`: rotas, validação, autenticação e respostas de erro.
- `src/orders.ts`: reserva, cancelamento, cotas e consulta do pool.
- `src/fifo.ts`: fila das operações.
- `src/database.ts` e `db/schema.sql`: conexões, transações e estrutura do banco.
- `src/web.ts` e `public/`: interface.
- `test/` e `scripts/`: testes e scripts de apoio.

O [documento de entrega em PDF](output/pdf/documento-entrega.pdf) reúne a
explicação técnica e os resultados. O [roteiro da apresentação](docs/apresentacao.md)
está separado para a fala de cinco minutos.
