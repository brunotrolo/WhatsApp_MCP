# Ferramentas MCP — WhatsApp

15 ferramentas: **6 recomendadas** (sempre ligadas) e **9 extras** (atrás do portão
`HABILITAR_FERRAMENTAS_EXTRAS`, desligadas por padrão). Toda ferramenta de **envio** confirma a
entrega (espera o recibo do WhatsApp) e retorna `{ entregue, status, id }`. Envio sempre para o
**destino fixo** (env `WHATSAPP_DESTINO`) — nenhuma aceita destinatário arbitrário.

Estados de mensagem: `pendente → enviado_ao_servidor → entregue → lido`. O ack de **entrega**
independe de recibos de leitura; o `lido` é best-effort.

## Recomendadas (sempre ligadas)

| Ferramenta | Parâmetros | O que faz |
|---|---|---|
| `enviar_mensagem_whatsapp` | `texto` | Texto (aceita markdown do WhatsApp: `*negrito*`, `_itálico_`, ` ```mono``` `). |
| `enviar_imagem_whatsapp` | `url` \| `base64`, `legenda?` | Imagem — gráficos de payoff, curva de capital, IV Rank, print do cockpit. |
| `enviar_documento_whatsapp` | `url` \| `base64`, `nome_arquivo`, `mimetype?`, `legenda?` | PDF/CSV/XLSX — relatórios, auditoria, posições. |
| `ler_mensagens_recebidas` | `limite?` | **Two-way:** lê as mensagens de texto recebidas pelo robô (o operador comanda pelo WhatsApp; o assistente lê e age). |
| `verificar_status_envio` | `id` | Reconfere entrega/leitura de um envio anterior pelo `id`. |
| `verificar_status_conexao` | — | Observabilidade: online?, desde quando, uptime, última entrega confirmada. |

## Extras (desligadas por padrão — `HABILITAR_FERRAMENTAS_EXTRAS=true`)

| Ferramenta | Parâmetros | O que faz |
|---|---|---|
| `enviar_audio_whatsapp` | `url`\|`base64`, `nota_de_voz?` | Áudio; `nota_de_voz=true` = mensagem de voz (PTT; requer ogg/opus). |
| `enviar_video_whatsapp` | `url`\|`base64`, `legenda?` | Vídeo com legenda opcional. |
| `enviar_sticker_whatsapp` | `url`\|`base64` | Sticker (idealmente webp). |
| `responder_mensagem_whatsapp` | `id_recebida`, `texto` | Responde **citando** (reply) uma mensagem recebida. |
| `editar_mensagem_whatsapp` | `id`, `novo_texto` | Edita uma mensagem já enviada (ex: alerta "resolvido"). |
| `apagar_mensagem_whatsapp` | `id` | Apaga **para todos** uma mensagem já enviada (retratar alerta falso). |
| `reagir_mensagem_whatsapp` | `id`, `emoji` | Reage com emoji a uma mensagem (recebida ou enviada). |
| `marcar_como_lida_whatsapp` | `id_recebida?` | Marca mensagens recebidas como lidas. |
| `enviar_presenca_whatsapp` | `tipo` | `composing` (digitando), `recording` (gravando), `paused`, `available`, `unavailable`. |

### Como autorizar os extras (na VM)
```bash
echo 'HABILITAR_FERRAMENTAS_EXTRAS=true' | sudo tee -a /etc/systemd/system/whatsapp-mcp.env
sudo systemctl restart whatsapp-mcp
```
(abra uma conversa nova no claude.ai para as novas ferramentas aparecerem).

> ⚠️ Cada capacidade "bot-like" a mais aumenta o risco de banimento da conexão não-oficial.
> Para um canal pessoal de alertas, mantenha só o necessário ligado.

## Limites e robustez de mídia
- Tamanho máximo por mídia: **16MB** (base64 ou baixada de URL). Acima disso, retorna erro.
- Timeouts: download de URL **20s**, upload ao WhatsApp **45s**. Se estourar, retorna erro em vez
  de **pendurar** a requisição (o hang de mídia sem timeout travava o chat do orquestrador).
- Corpo da requisição aceita até **25MB** (para mídia em base64).

## Formato de resposta (envios)
```json
{ "resultado": "ENTREGUE no aparelho do destinatário.", "entregue": true, "status": "entregue", "id": "3EB0..." }
```
`entregue=false` ⇒ o destino pode estar offline; reenvie/logue ou reconfira com `verificar_status_envio`.
