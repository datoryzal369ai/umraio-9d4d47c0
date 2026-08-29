import { useEffect, useRef } from "react";

import { supabase } from "@/integrations/supabase/client";
import {
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  decideLoginEvent,
  sessionKeyOf,
  shouldSendHeartbeat,
} from "@/lib/identity/identity.core";
import { recordLoginEvent, recordPresenceHeartbeat } from "@/lib/identity/identity.functions";

/**
 * Y-6B — emits login/logout events and a throttled presence heartbeat.
 * No UI. Deduped per session so rerenders and route changes cannot flood.
 */
export function useIdentitySignals(): void {
  const seen = useRef<Set<string>>(new Set());
  const lastHeartbeat = useRef<number | null>(null);
  const lastSessionKey = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const beat = async () => {
      if (!lastSessionKey.current) return;
      const now = Date.now();
      if (!shouldSendHeartbeat(lastHeartbeat.current, now)) return;
      lastHeartbeat.current = now;
      try {
        await recordPresenceHeartbeat();
      } catch {
        /* presence is best-effort */
      }
    };

    const emit = async (eventType: "login" | "logout", sessionKey: string | null) => {
      const decision = decideLoginEvent({ eventType, sessionKey, seen: seen.current });
      if (!decision.record) return;
      try {
        await recordLoginEvent({ data: { eventType, sessionKey: decision.sessionKey } });
      } catch {
        /* identity logging must never break the app */
      }
    };

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const key = sessionKeyOf(data.session);
      if (!key) return;
      lastSessionKey.current = key;
      void emit("login", key);
      void beat();
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN") {
        const key = sessionKeyOf(session);
        if (!key) return;
        lastSessionKey.current = key;
        void emit("login", key);
        void beat();
        return;
      }
      if (event === "SIGNED_OUT") {
        const key = lastSessionKey.current;
        lastSessionKey.current = null;
        void emit("logout", key);
      }
    });

    const timer = setInterval(() => void beat(), PRESENCE_HEARTBEAT_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      sub.subscription.unsubscribe();
    };
  }, []);
}
