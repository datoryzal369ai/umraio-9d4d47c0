update public.conversations
set ai_enabled = true,
    human_attention_required = false,
    conversation_state = 'ACTIVE',
    state_updated_at = now(),
    escalated_at = null,
    escalation_reason = null
where id = 'a3e7cd05-1b85-4c9d-88e2-7464dfc0ac5b'
  and agency_id = 'efaa961f-4f40-441c-8acd-53cd13061723';