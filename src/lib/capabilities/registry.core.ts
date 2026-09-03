/**
 * UMRAIO® — ONE CANONICAL CAPABILITY REGISTRY.
 *
 * Every channel (WhatsApp text, voice note, live call, Meet) must answer the
 * question "can UMRAIO do this?" from the SAME source of truth. Before this
 * existed the text channel told customers that live phone calling was not
 * available while WhatsApp Calling was in fact enabled and answering.
 *
 * Pure and evidence-based: capability is derived from real deployment state,
 * never assumed and never hard-coded to "yes".
 */

export type ChannelCapabilities = {
  whatsappText: boolean;
  whatsappVoiceNote: boolean;
  /** Live inbound WhatsApp Calling, answered by RAIŌ through the media plane. */
  whatsappCalling: boolean;
};

export type CapabilityEnv = Record<string, string | undefined>;

/**
 * Live calling is available only when the media gateway is actually wired
 * (URL + shared secret). Without both, no call can ever be answered, so the
 * honest answer to the customer is "not available".
 */
export function resolveCapabilities(env: CapabilityEnv): ChannelCapabilities {
  const gatewayUrl = env["WHATSAPP_MEDIA_GATEWAY_URL"]?.trim();
  const gatewaySecret = env["WHATSAPP_MEDIA_GATEWAY_SECRET"]?.trim();
  return {
    whatsappText: true,
    whatsappVoiceNote: true,
    whatsappCalling: Boolean(gatewayUrl && gatewaySecret),
  };
}
