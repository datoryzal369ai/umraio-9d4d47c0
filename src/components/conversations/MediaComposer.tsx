/**
 * B-4.4 — OUTBOUND MEDIA COMPOSER.
 *
 * Voice recording, image and PDF attachments sent to the customer through the
 * server-only WhatsApp media path. No Meta token, no service-role credential
 * and no provider URL ever exists in this component.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileText, ImageIcon, Loader2, Mic, Send, Square, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  MAX_OUTBOUND_BYTES,
  OUTBOUND_DOCUMENT_MIME,
  OUTBOUND_IMAGE_MIME,
  PREFERRED_RECORDING_MIME,
  formatBytes,
  formatDuration,
  normalizeOutboundMime,
  validateOutboundMedia,
  type OutboundMediaKind,
} from "@/lib/conversations/outbound-media.core";
import { sendConversationMedia } from "@/lib/conversations/outbound-media.functions";

type Attachment = {
  kind: OutboundMediaKind;
  mimeType: string;
  filename: string | null;
  byteLength: number;
  objectUrl: string;
  blob: Blob;
};

type ComposerState = "idle" | "recording" | "preparing" | "sending" | "failed";

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pickRecordingMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const candidate of PREFERRED_RECORDING_MIME) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

export function MediaComposer({
  conversationId,
  onSent,
  disabled,
}: {
  conversationId: string;
  onSent: () => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<ComposerState>("idle");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (attachment) URL.revokeObjectURL(attachment.objectUrl);
    };
  }, [attachment]);

  useEffect(() => {
    if (state !== "recording") return;
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [state]);

  function clearAttachment() {
    setAttachment((current) => {
      if (current) URL.revokeObjectURL(current.objectUrl);
      return null;
    });
    setState("idle");
  }

  function acceptBlob(blob: Blob, filename: string | null) {
    const mimeType = normalizeOutboundMime(blob.type);
    const validation = validateOutboundMedia({ mimeType, byteLength: blob.size });
    if (!validation.ok) {
      toast.error(validation.message);
      return;
    }
    setAttachment({
      kind: validation.kind,
      mimeType: validation.mimeType,
      filename,
      byteLength: blob.size,
      objectUrl: URL.createObjectURL(blob),
      blob,
    });
    setState("preparing");
  }

  async function startRecording() {
    const mime = pickRecordingMime();
    if (!mime) {
      toast.error("Voice recording isn't supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      cancelledRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (cancelledRef.current) {
          setState("idle");
          return;
        }
        const blob = new Blob(chunksRef.current, { type: normalizeOutboundMime(mime) });
        acceptBlob(blob, "voice-note.ogg");
      };
      recorderRef.current = recorder;
      setSeconds(0);
      recorder.start();
      setState("recording");
    } catch {
      toast.error("Microphone access was denied.");
    }
  }

  function stopRecording(cancel: boolean) {
    cancelledRef.current = cancel;
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  const send = useMutation({
    mutationFn: async (item: Attachment) => {
      const base64 = await blobToBase64(item.blob);
      return sendConversationMedia({
        data: {
          conversationId,
          mimeType: item.mimeType,
          base64,
          filename: item.filename,
        },
      });
    },
    onMutate: () => setState("sending"),
    onSuccess: () => {
      clearAttachment();
      toast.success("Media sent on WhatsApp.");
      onSent();
    },
    onError: (error: Error) => {
      setState("failed");
      toast.error(error.message);
      onSent();
    },
  });

  const busy = state === "sending" || Boolean(disabled);

  return (
    <div className="space-y-2">
      <input
        ref={imageInputRef}
        type="file"
        accept={OUTBOUND_IMAGE_MIME.join(",")}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) acceptBlob(file, file.name);
        }}
      />
      <input
        ref={docInputRef}
        type="file"
        accept={OUTBOUND_DOCUMENT_MIME.join(",")}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) acceptBlob(file, file.name);
        }}
      />

      {attachment && (
        <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/30 p-3">
          {attachment.kind === "image" ? (
            <img
              src={attachment.objectUrl}
              alt="Attachment preview"
              className="size-14 rounded-lg object-cover"
            />
          ) : attachment.kind === "audio" ? (
            // Never autoplays — the agent chooses to review the recording.
            <audio controls preload="none" src={attachment.objectUrl} className="h-9" />
          ) : (
            <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <FileText className="size-5" />
            </span>
          )}
          <div className="min-w-0 flex-1 text-xs">
            <p className="truncate font-medium">{attachment.filename ?? attachment.kind}</p>
            <p className="text-muted-foreground">
              {formatBytes(attachment.byteLength)} ·{" "}
              {state === "sending"
                ? "Sending…"
                : state === "failed"
                  ? "Send failed"
                  : "Ready to send"}
            </p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-9"
            aria-label="Discard attachment"
            disabled={state === "sending"}
            onClick={clearAttachment}
          >
            <X className="size-4" />
          </Button>
          <Button
            size="sm"
            className="gap-2"
            disabled={state === "sending"}
            onClick={() => send.mutate(attachment)}
          >
            {state === "sending" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            {state === "failed" ? "Retry" : "Send"}
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2">
        {state === "recording" ? (
          <>
            <span
              className="flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive"
              aria-live="polite"
            >
              <span className="size-2 animate-pulse rounded-full bg-destructive" />
              Recording {formatDuration(seconds)}
            </span>
            <Button size="sm" variant="secondary" className="gap-2" onClick={() => stopRecording(false)}>
              <Square className="size-3.5" /> Stop
            </Button>
            <Button size="sm" variant="ghost" onClick={() => stopRecording(true)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="size-10"
              aria-label="Record voice note"
              disabled={busy}
              onClick={startRecording}
            >
              <Mic className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-10"
              aria-label="Attach image"
              disabled={busy}
              onClick={() => imageInputRef.current?.click()}
            >
              <ImageIcon className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-10"
              aria-label="Attach PDF document"
              disabled={busy}
              onClick={() => docInputRef.current?.click()}
            >
              <FileText className="size-4" />
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Images ≤ {Math.round(MAX_OUTBOUND_BYTES.image / (1024 * 1024))} MB · PDF ≤{" "}
              {Math.round(MAX_OUTBOUND_BYTES.document / (1024 * 1024))} MB
            </span>
          </>
        )}
      </div>
    </div>
  );
}
