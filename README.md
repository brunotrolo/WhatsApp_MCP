# WhatsApp MCP (Baileys puro)

Servidor MCP para um assistente (ex.: Claude) mandar alertas no WhatsApp pessoal do
operador, **com confirmação de entrega e observabilidade do canal**. Usa
[Baileys](https://github.com/WhiskeySockets/Baileys) diretamente (sem Evolution API,
sem Postgres, sem Redis), rodando numa VM Compute Engine `e2-micro` sempre ligada
(Always Free tier do Google Cloud — custo ~R$0/mês).

> **Por que VM e não Cloud Run?** A sessão WhatsApp Web exige um WebSocket persistente;
> o Cloud Run congela a CPU do container entre requisições. Ver [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## 📚 Documentação

| Documento | Conteúdo |
|---|---|
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | Arquitetura no Google Cloud (VM e2-micro, Caddy+sslip.io, IP estático, systemd), auth, deploy e custo. |
| [`docs/FERRAMENTAS.md`](docs/FERRAMENTAS.md) | As 15 ferramentas MCP em detalhe (parâmetros, recomendadas × extras, confirmação de entrega). |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | A saga de bugs e seus fixes (405, git ownership, 9º dígito, OAuth, timing de deploy…). |

Contexto do ecossistema (os 3 MCPs, estudo de viabilidade, monitoria de custos):
repo [GoogleCloud_Projects](https://github.com/brunotrolo/GoogleCloud_Projects).

## Ferramentas

Toda ferramenta de **envio confirma a entrega** (espera o recibo do WhatsApp) e retorna
`{ entregue, status, id }`. Status: `pendente → enviado_ao_servidor → entregue → lido`. O ack
de **entrega** independe de recibos de leitura; o `lido` é best-effort. `GET /health` expõe a
mesma observabilidade (uptime check externo).

### Recomendadas (sempre ligadas)
| Ferramenta | O que faz |
|---|---|
| `enviar_mensagem_whatsapp(texto)` | Texto (aceita markdown do WhatsApp: `*negrito*`, `_itálico_`, ` ```mono``` `). |
| `enviar_imagem_whatsapp(url\|base64, legenda?)` | Imagem — gráficos de payoff/curva de capital/IV Rank/print do cockpit. |
| `enviar_documento_whatsapp(url\|base64, nome_arquivo, legenda?)` | PDF/CSV/XLSX — relatórios, auditoria, posições. |
| `ler_mensagens_recebidas(limite?)` | **Two-way:** lê as mensagens recebidas pelo robô (o operador comanda pelo WhatsApp; o assistente lê e age). |
| `verificar_status_envio(id)` | Reconfere entrega/leitura de um envio anterior. |
| `verificar_status_conexao()` | Observabilidade do canal (online? desde quando? última entrega OK?). |

### Extras (desligadas por padrão — atrás de `HABILITAR_FERRAMENTAS_EXTRAS`)
Implementadas para exploração futura; só aparecem/funcionam com `HABILITAR_FERRAMENTAS_EXTRAS=true`:

| Ferramenta | O que faz |
|---|---|
| `enviar_audio_whatsapp(url\|base64, nota_de_voz?)` | Envia áudio; com `nota_de_voz=true` manda como mensagem de voz (PTT — requer ogg/opus p/ tocar bem). |
| `enviar_video_whatsapp(url\|base64, legenda?)` | Envia vídeo com legenda opcional. |
| `enviar_sticker_whatsapp(url\|base64)` | Envia um sticker (idealmente webp). |
| `responder_mensagem_whatsapp(id_recebida, texto)` | Responde **citando** (reply/quote) uma mensagem recebida, pelo id de `ler_mensagens_recebidas`. |
| `editar_mensagem_whatsapp(id, novo_texto)` | Edita uma mensagem já enviada por este servidor (ex: marcar alerta como "resolvido"). |
| `apagar_mensagem_whatsapp(id)` | Apaga **para todos** uma mensagem já enviada (retratar alerta falso). |
| `reagir_mensagem_whatsapp(id, emoji)` | Reage com emoji a uma mensagem (recebida ou enviada). |
| `marcar_como_lida_whatsapp(id_recebida?)` | Marca mensagens recebidas como lidas (uma específica, ou as últimas). |
| `enviar_presenca_whatsapp(tipo)` | Envia presença ao destino: `composing` (digitando), `recording` (gravando), `paused`, `available`, `unavailable`. |

**Para autorizar os extras** (na VM):
```bash
echo 'HABILITAR_FERRAMENTAS_EXTRAS=true' | sudo tee -a /etc/systemd/system/whatsapp-mcp.env
sudo systemctl restart whatsapp-mcp
```
(abra uma conversa nova no claude.ai para as novas ferramentas aparecerem).

> ⚠️ Cada capacidade "bot-like" a mais aumenta o risco de banimento da conexão não-oficial.
> Para um canal pessoal de alertas, mantenha só o necessário ligado.

## Dois números, dois papéis
- **Remetente (robô):** número que escaneia o QR e mantém a sessão. Use um número
  **secundário** (reduz risco de banimento do principal).
- **Destino (`WHATSAPP_DESTINO`):** onde os alertas chegam — seu número principal.
- Se remetente == destino, a mensagem vai para o chat "Mensagem para mim". Use números diferentes.

## Deploy
Provisionado pelo script `scripts/aplicar_whatsapp_mcp.sh` do repo `GoogleCloud_Projects`,
que também cria a VM, o firewall, o IP estático e o HTTPS (Caddy + `sslip.io`). Este
repositório é publicado automaticamente por esse script.

## Endpoints
| Método/rota | Descrição |
|---|---|
| `POST /mcp/:key` | MCP autenticado pela **chave no path** — é esta a URL usada no conector do claude.ai: `https://<host>/mcp/<MCP_API_KEY>`. |
| `POST /mcp` | MCP autenticado pelo header `x-api-key` (curl/testes). |
| `GET /health` | Público: `{ "status": "ok", "whatsapp": "conectado" \| "reconectando" \| "aguardando_qr" \| "deslogado_precisa_novo_qr" }`. |

## Variáveis de ambiente (`/etc/systemd/system/whatsapp-mcp.env` na VM)
| Variável | Descrição |
|---|---|
| `MCP_API_KEY` | Chave exigida em `/mcp` (header) e `/mcp/:key` (path). Gerada no deploy. |
| `WHATSAPP_DESTINO` | Número de destino, só dígitos ou JID (`5511999999999` ou `...@s.whatsapp.net`). O código resolve o JID canônico via `onWhatsApp()` (trata o "9º dígito" do Brasil). |
| `PORT` | Porta interna do Node (padrão 8080; Caddy faz o HTTPS na frente). |
| `HABILITAR_FERRAMENTAS_EXTRAS` | `true` liga as ferramentas extras (áudio, vídeo, sticker, editar, apagar, reagir, responder, marcar_lida, presença). Padrão: desligado. |

## Pareamento (1ª vez / após logout)
```bash
gcloud compute ssh whatsapp-mcp-vm --project=<PROJECT_ID> --zone=us-east1-b
sudo journalctl -u whatsapp-mcp -f
```
Escaneie o QR com o celular **remetente** (WhatsApp → Aparelhos conectados → Conectar um aparelho).
A sessão fica salva em `auth_info_baileys` e reconecta sozinha.

## Troubleshooting
A saga de bugs (405, `dubious ownership` do git, 9º dígito, número errado, OAuth do
conector) está documentada em `docs/whatsapp-mcp-arquitetura.md` no repo GoogleCloud_Projects
— leia antes de repetir os erros.

## Licença
MIT — ver `LICENSE`.
