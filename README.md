# Ingresos API

API local para disputar 100 ingressos, com até duas reservas ativas por usuário.
Implementação em Node.js 24, TypeScript, Fastify 5 e PostgreSQL 18.

Aluno: João Pedro Wanderley do Nascimento. Repositório:
[KonradKurzeVIII/ProjetoHugoIngressos](https://github.com/KonradKurzeVIII/ProjetoHugoIngressos).

## Aplicação web

Acesse `http://localhost:8080` para usar a interface, servida pela própria API.
Não há servidor de frontend separado nem dependências externas no navegador.
O HTML, CSS e JavaScript ficam em `public/` e também são incluídos na imagem Docker.

A interface permite criar conta, entrar, consultar disponibilidade, adicionar
pedidos ao carrinho, reservar e cancelar com confirmação. Mostra reservas,
carrinhos e cancelamentos da conta. A terceira reserva recebe a recusa real da
API, e o pedido permanece no carrinho. O botão principal reutiliza um carrinho
existente antes de criar outro pedido.

O token fica somente no `sessionStorage` da aba; a senha não é armazenada pelo
cliente. Recarregar a página ou entrar novamente consulta os pedidos no banco.
Sair encerra a sessão no navegador e preserva as reservas. A disponibilidade
é atualizada a cada cinco segundos enquanto a aba está visível e autenticada.
O banco continua sendo a autoridade sobre vagas, estados e propriedade.

Foi acrescentado `GET /pedidos`, autenticado, com resposta
`200 {"pedidos":[{"id":42,"status":"RESERVADO"}]}`. Essa listagem sempre filtra
pelo usuário do JWT; parâmetros fornecidos pelo cliente não alteram o proprietário.
A interface usa CSP, recursos locais e inserção de texto sem HTML de usuário.

## Executar a entrega com Docker

Pré-requisito: Docker com Compose e suporte a containers Linux. Não é necessário
instalar Node.js ou PostgreSQL no host.

```sh
docker compose down -v
docker compose up --build -d
docker compose ps
```

A API fica em `http://localhost:8080`. O healthcheck
`GET /health` retorna `200 {"status":"ok"}` quando banco e API estão disponíveis.
O banco não publica porta no host. O volume persiste os dados; `down -v` os apaga.
O schema e o show 7 são criados automaticamente antes de a API começar a atender.

```sh
docker compose logs api
docker compose down
```

Use uma única instância da API: FIFO é centralizado no processo. O bloqueio no
PostgreSQL mantém as cotas mesmo com escritores independentes que respeitem o
mesmo protocolo, mas não fornece FIFO entre instâncias diferentes.

## Contrato HTTP

Os dois endpoints de autenticação são públicos. Todas as rotas de pedidos e
`GET /pool` exigem `Authorization: Bearer <token>`.

```http
POST /auth/registrar
Content-Type: application/json

{"username":"joao","password":"senha123"}
```

Retorna `201 Created`, sem corpo. Nome repetido: `409 {"error":"USUARIO_EXISTENTE"}`.
Nome é sensível a maiúsculas. Senhas são armazenadas com scrypt e salt aleatório.

```http
POST /auth/login
Content-Type: application/json

{"username":"joao","password":"senha123"}
```

Retorna `200 {"token":"..."}`. Credenciais inválidas: `401 {"error":"NAO_AUTORIZADO"}`.
O JWT usa HS256 e expira em duas horas. Sem `JWT_SECRET`, um segredo aleatório é
gerado no startup: reiniciar a API invalida tokens anteriores. Para persistir
sessões, configure um segredo privado de pelo menos 32 caracteres em `.env`,
conforme `.env.example`. Não publique esse arquivo.

```http
POST /pedidos
Authorization: Bearer <token>
Content-Type: application/json

{"showId":7}
```

Retorna `201 {"id":42,"status":"NO_CARRINHO"}`. Criar carrinho não consome vaga.

```http
POST /pedidos/42/reservar
Authorization: Bearer <token>
```

Sucesso: `200 {"id":42,"status":"RESERVADO"}`, sempre com `X-Lote: 7F3A`.
Recusas: `409 {"error":"COTA_PESSOAL"}` ou `409 {"error":"POOL_CHEIO"}`.
O pedido permanece em `NO_CARRINHO` quando a reserva é recusada.

```http
POST /pedidos/42/cancelar
Authorization: Bearer <token>
```

Retorna `200 {"id":42,"status":"CANCELADO"}`. Libera uma vaga e a cota pessoal.
Pedido alheio ou inexistente retorna `404 {"error":"NAO_ENCONTRADO"}` em ambas
as operações, inclusive quando a operação seria uma repetição.

```http
GET /pool
Authorization: Bearer <token>
```

Retorna `200 {"total":100,"ocupadas":37,"livres":63}`. A contagem usa uma única
consulta e um único snapshot do banco.

## Decisões para lacunas do enunciado

- Existe um show, com `showId: 7` e capacidade fixa de 100. Outros IDs retornam 400.
- Cada pedido representa um ingresso. Não existe expiração automática de reserva.
- Repetir reserva já confirmada retorna 200 e `X-Lote`, sem consumir outra vaga.
- Repetir cancelamento já confirmado retorna 200, sem liberar outra vaga.
- Cancelar carrinho ou reservar pedido cancelado retorna
  `409 {"error":"ESTADO_INVALIDO"}`.
- A propriedade é verificada antes do estado e das cotas. Para uma nova reserva,
  cota pessoal tem prioridade sobre pool cheio quando ambas se aplicam.
- JSON, tipos ou campos inválidos retornam `400 {"error":"DADOS_INVALIDOS"}`.
  JWT ausente, inválido ou expirado retorna 401.
- Falha real de infraestrutura não é convertida em erro de negócio. Indisponibilidade
  reconhecida do banco retorna 503; um defeito inesperado retorna 500 e é registrado.

## Concorrência e ausência de deadlines de processamento

Chegada significa admissão na FIFO após autenticação e validação da requisição.
Não significa horário do clique, ordem dos pacotes TCP ou chegada antes do login.
Reservas e cancelamentos usam a mesma fila, que continua depois de uma recusa.

1. A requisição entra na fila, sem ocupar conexão ou abrir transação.
2. Quando chega sua vez, abre uma transação `READ COMMITTED`.
3. Executa `SELECT ... FOR NO KEY UPDATE` no registro do show 7.
4. Verifica proprietário, estado e cotas; altera o pedido quando permitido.
5. Executa `COMMIT` antes de responder. Em falha, executa `ROLLBACK` e libera conexão.

Todas as mutações de reserva/cancelamento adquirem o mesmo bloqueio. Portanto,
outra mutação não pode verificar as cotas entre a verificação e a atualização
da primeira. Há um único ponto de disputa, sem ordens de aquisição de locks
concorrentes que formem ciclos. Carrinhos e leituras não entram nessa fila.
O índice parcial mantém a consulta das reservas focada no conjunto ativo.
O modo `NO KEY UPDATE` mantém a exclusão entre reservas e cancelamentos, mas
permite a verificação da chave estrangeira de novos carrinhos durante uma reserva.

Não há contadores de estoque duplicados: ocupação e cota são derivadas dos pedidos
em `RESERVADO`. Um cancelamento repetido é reconhecido antes de qualquer alteração.
Transações e locks pertencem ao PostgreSQL e são liberados quando a conexão morre.
Um cliente que perder a resposta após o commit pode repetir a operação com segurança.

A API não define deadline para processamento (`requestTimeout: 0` e
`connectionTimeout: 0`). O pool tem dez conexões e não expira sua espera;
`statement_timeout` e `lock_timeout` são zero. O servidor usa backlog 4096.
Limites para cabeçalhos incompletos e conexões ociosas continuam sendo os do Node;
eles não interrompem uma reserva completa aguardando sua vez.

Essas escolhas evitam que deadlines internos matem operações saudáveis sob a
carga medida. Não prometem latência constante, RAM infinita ou resposta durante
falha do sistema operacional, falta de disco, queda do processo ou bloqueio externo
mantido indefinidamente. A fila reside em memória; requisições pendentes se perdem
se o processo cair, e os clientes devem repeti-las. O estado confirmado fica no banco.
Não escreva diretamente no banco contornando o protocolo de bloqueio.

## Testes de integração

Com Docker, sem instalar ferramentas adicionais no host:

```sh
docker compose -f docker-compose.yml -f docker-compose.test.yml run --build --rm tests
```

A suíte cria um schema isolado, executa a API numa porta efêmera e apaga somente
seu próprio schema no final. Não modifica pedidos da API principal. O container
de testes precisa acessar o serviço `db`; não usa PostgreSQL embarcado.

Com Node.js 24, para desenvolvimento local:

```sh
npm ci
npm run typecheck
npm run build
npm test
```

Sem `TEST_DATABASE_URL`, os testes iniciam PostgreSQL real portátil em diretório
temporário dentro de `.tools`, em uma porta livre, e removem esse cluster no final.
O pacote `embedded-postgres` é exclusivamente uma dependência de desenvolvimento.

A suíte verifica autenticação e validação, propriedade, estados, retries,
`X-Lote`, 50 reservas concorrentes do mesmo usuário, repetição concorrente do
mesmo pedido, 1.000 reservas concorrentes, FIFO observado no servidor, leituras
consistentes durante a disputa, cancelamentos concorrentes, rollback e proteção
das cotas com filas independentes compartilhando o mesmo banco.

O ensaio de 1.000 reservas estabelece as conexões HTTP gradualmente antes de
disparar as requisições juntas. Isso mede processamento HTTP e banco, sem confundir
o resultado com uma rajada de abertura de conexões TCP. Cadastro e
carrinhos são fixtures SQL; JWTs válidos são assinados pela própria aplicação.
Os endpoints de autenticação são testados separadamente. A carga usa HTTP real,
sem mocks do banco ou injeção de requisições do Fastify.
Um teste adicional injeta uma desconexão sem código, como a emitida pelo driver
`pg`, e verifica resposta 503, preservação do carrinho e recuperação da fila.
Outro mantém o bloqueio de reserva no show e verifica que criar carrinho não espera.

O resultado é gravado em `output/load-results.json`. O deadline total de 30 segundos
pertence ao cliente de teste e inclui conexão e espera: se atingido, a prova falha.
Não é um timeout da API. O campo `containerExecutionVerified` identifica a execução
da suíte pelo serviço `tests` do Compose.
Métricas são evidência da máquina e carga testadas, não promessa universal.

O workflow `.github/workflows/conformidade.yml` executa os comandos obrigatórios
de inicialização, aguarda os healthchecks, roda a suíte em containers e aplica a
carga externa na API de produção. Os relatórios JSON ficam nos artifacts do job.

## Carga externa, com cadastro e login HTTP

Com a API em execução e pool vazio:

```sh
npm run load
```

Por padrão, cadastra 200 usuários, faz login, cria dois carrinhos por usuário,
estabelece as conexões e disputa 400 reservas simultaneamente. Espera 100 sucessos,
confere `X-Lote`, verifica o pool e cancela somente suas próprias reservas ao final.
Contas e pedidos cancelados permanecem no banco. Se o teste falhar ou for
interrompido, algumas reservas desse teste podem permanecer ativas.

Para usar apenas Docker:

```sh
docker compose -f docker-compose.yml -f docker-compose.test.yml run --build --rm -e BASE_URL=http://api:8080 tests npm run load
```

`BASE_URL` e `LOAD_USERS` permitem alterar o destino e a carga. A medição exclui
cadastro/login e preparação das conexões. Resultado em
`output/blackbox-load-results.json` no ambiente em que o cliente foi executado.

## Execução nativa para desenvolvimento

Com Node.js 24 e dependências já baixadas:

```sh
npm run local
```

Inicia PostgreSQL portátil em `127.0.0.1:54329` e a API em `127.0.0.1:8080`.
Dados e credenciais aleatórias persistem em `.tools`, excluído do Git e da imagem.
Encerre com Ctrl+C. Esta alternativa não substitui a entrega obrigatória em Compose.

## Organização e entrega

- `src/app.ts`: HTTP, validação, JWT e tratamento de erros.
- `src/web.ts` e `public/`: interface web, assets locais e política de conteúdo.
- `src/orders.ts`: estados, cotas, cancelamento e consulta do pool.
- `src/fifo.ts`: ordem de admissão e eventos nativos de diagnóstico.
- `src/database.ts` e `db/schema.sql`: transações, pool, schema e índice.
- `test/`: integração HTTP/PostgreSQL e prova da fila.
- `scripts/`: execução local, carga e geração do PDF técnico.
- `docs/`: identificação e roteiro da apresentação.
- `output/`: resultados medidos e PDF de entrega.

O PDF técnico é gerado por `scripts/create-delivery-pdf.py`, com ReportLab.
O arquivo `docs/identificacao.json` contém o nome do aluno e a URL do repositório.
Atualize os resultados e regenere o PDF antes da entrega. Python/ReportLab são necessários
para regenerar o documento, não para executar a API ou os testes em Compose.

## Validação da entrega

Em 11/11/2026, a [execução de conformidade no GitHub Actions](https://github.com/KonradKurzeVIII/ProjetoHugoIngressos/actions/runs/43113509505)
validou o build e a inicialização com os dois comandos exigidos pelo enunciado,
os healthchecks, os 14 testes e a carga externa contra a API de produção em containers Linux.

O ensaio de 1.000 tentativas confirmou 100 reservas, 900 recusas `POOL_CHEIO`,
zero resposta inesperada e zero timeout. A latência p95 foi 1.247,08 ms. A carga
externa de 400 tentativas confirmou 100 reservas e 300 recusas, sem timeout,
e cancelou suas reservas ao final. Os testes nativos com PostgreSQL real também passaram.

`output/compose-verification.json` identifica o commit testado e a execução.
Os relatórios `output/load-results.json` e `output/blackbox-load-results.json`
foram extraídos dessa execução em containers. A documentação final acrescenta
as evidências sem alterar o código executado pelo workflow.
