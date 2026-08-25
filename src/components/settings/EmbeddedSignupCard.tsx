import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  buildEmbeddedSignupLaunchParams,
  parseEmbeddedSignupMessage,
  type EmbeddedSignupSessionInfo,
} from "@/lib/whatsapp/embedded-signup.core";
import {
  completeEmbeddedSignup,
  getEmbeddedSignupConfig,
} from "@/lib/whatsapp/embedded-signup.functions";

type FbLoginResponse = { authResponse?: { code?: string } | null };
type Fb = {
  init: (options: Record<string, unknown>) => void;
  login: (cb: (response: FbLoginResponse) => void, options: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    FB?: Fb;
  }
}

const SDK_ID = "facebook-jssdk";

function loadFacebookSdk(appId: string, graphVersion: string): Promise<Fb> {
  return new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB);
    const finish = () => {
      if (!window.FB) return reject(new Error("Meta SDK unavailable"));
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion });
      resolve(window.FB);
    };
    const existing = document.getElementById(SDK_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", finish, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = SDK_ID;
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = finish;
    script.onerror = () => reject(new Error("Meta SDK failed to load"));
    document.body.appendChild(script);
  });
}

type UiState = "idle" | "connecting" | "connected" | "failed";

export function EmbeddedSignupCard({ isConnected }: { isConnected: boolean }) {
  const queryClient = useQueryClient();
  const sessionRef = useRef<EmbeddedSignupSessionInfo | null>(null);
  const [state, setState] = useState<UiState>(isConnected ? "connected" : "idle");

  const { data: config } = useQuery({
    queryKey: ["embedded-signup-config"],
    queryFn: () => getEmbeddedSignupConfig(),
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const info = parseEmbeddedSignupMessage(event.origin, event.data);
      if (info) sessionRef.current = info;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const complete = useMutation({
    mutationFn: (input: { code: string } & EmbeddedSignupSessionInfo) =>
      completeEmbeddedSignup({ data: input }),
    onSuccess: () => {
      setState("connected");
      toast.success("WhatsApp connected");
      queryClient.invalidateQueries({ queryKey: ["whatsapp-config"] });
    },
    onError: (error: Error) => {
      setState("failed");
      toast.error(error.message || "Connection failed — try again");
    },
  });

  const launch = async () => {
    if (!config?.appId) {
      toast.error("WhatsApp onboarding is not configured yet.");
      return;
    }
    setState("connecting");
    sessionRef.current = null;
    try {
      const fb = await loadFacebookSdk(config.appId, config.graphVersion);
      fb.login(
        (response) => {
          const code = response?.authResponse?.code;
          const session = sessionRef.current;
          if (!code || !session) {
            setState("failed");
            toast.error("Connection failed — try again");
            return;
          }
          complete.mutate({ code, ...session });
        },
        buildEmbeddedSignupLaunchParams(),
      );
    } catch {
      setState("failed");
      toast.error("Connection failed — try again");
    }
  };

  const label =
    state === "connecting" || complete.isPending
      ? "Connecting to Meta…"
      : state === "connected"
        ? "Reconnect WhatsApp with Meta"
        : "Connect WhatsApp with Meta";

  return (
    <section className="panel space-y-4 border-primary/30 p-5">
      <div className="flex items-center gap-3">
        <div className="rounded-xl border border-border/60 bg-surface p-2.5">
          <MessageCircle className="size-4 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-base font-semibold">Connect with Meta</h2>
          <p className="text-xs text-muted-foreground">
            One-click onboarding. Meta hands the credentials straight to UMRAIO — no tokens to copy.
          </p>
        </div>
      </div>

      <Button size="lg" onClick={launch} disabled={state === "connecting" || complete.isPending}>
        {label}
      </Button>

      <p className="text-xs text-muted-foreground">
        {state === "connected"
          ? "WhatsApp connected."
          : state === "failed"
            ? "Connection failed — try again."
            : config && !config.configured
              ? "Onboarding is temporarily unavailable."
              : "You'll be asked to sign in to Meta and pick your WhatsApp Business number."}
      </p>
    </section>
  );
}
