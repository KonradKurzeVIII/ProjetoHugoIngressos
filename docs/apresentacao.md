# Roteiro de apresentação - 5 minutos

## 0:00 a 0:40 - Problema e contrato

Apresentar o show 7, os 100 ingressos e a cota de duas reservas por usuário.
Criar um carrinho não ocupa vaga. Somente cancelar uma reserva libera a vaga.
Mostrar os estados e os erros exatos. Apontar `X-Lote: 7F3A` nas reservas 200.

## 0:40 a 2:30 - Concorrência

Explicar primeiro a diferença entre FIFO e atomicidade. A fila ordena a admissão
das requisições autenticadas no processo; o PostgreSQL protege a decisão sobre
estoque e cota. O bloqueio no show é adquirido antes de consultar as reservas e
permanece até o commit ou rollback. Mostrar `src/orders.ts`.

Descrever uma corrida: duas requisições disputam a última vaga; a primeira verifica
99 reservas, atualiza e confirma. A segunda só então adquire o bloqueio, enxerga
100 e retorna `409 POOL_CHEIO`, mantendo seu pedido no carrinho.

Mostrar que cancelamentos usam o mesmo caminho e que retries reconhecem o estado
já concluído. Explicar por que a espera na FIFO não mantém uma transação aberta.

## 2:30 a 3:40 - Demonstração

Executar o Compose e abrir `http://localhost:8080`. Pela interface, cadastrar
usuário, entrar e reservar um ingresso. Mostrar a confirmação e o pedido na lista.
Demonstrar o cancelamento com confirmação e a disponibilidade atualizada.
Mostrar corpo e header de uma reserva pelo cliente HTTP ou pelas ferramentas do
navegador, destacando `X-Lote: 7F3A`.
Se houver tempo, mostrar uma terceira reserva recusada por cota pessoal.

## 3:40 a 4:30 - Evidência

Mostrar `output/load-results.json`: 1.000 requisições concorrentes em conexões
estabelecidas, 100 sucessos, 900 recusas por pool, nenhuma resposta inesperada
nem timeout. Apresentar as latências realmente gravadas e a verificação de FIFO.
Mostrar que os testes também consultam o banco e acompanham o pool durante a carga.

## 4:30 a 5:00 - Limitações honestas

FIFO exige uma instância da API. A fila pendente está em memória e não sobrevive
à queda do processo; commits permanecem no PostgreSQL e retries são seguros.
Sem deadlines internos de processamento, a latência cresce com a fila. Os
resultados demonstram a carga executada, não capacidade infinita.
Mostrar a execução de conformidade aprovada no GitHub Actions, com build,
inicialização pelo Compose, 14 testes e carga na API de produção em containers.
