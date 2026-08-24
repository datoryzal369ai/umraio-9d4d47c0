/**
 * B-4.3 — READ-ONLY media rendering inside the conversation timeline.
 *
 * Media bytes are resolved on demand through an authenticated, agency-scoped
 * server function. No provider token, no storage URL and no service-role
 * credential ever reaches this component.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { FileText, ImageIcon, Loader2, Mic, Paperclip, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { resolveMessageMedia, type ResolvedMedia } from "@/lib/conversations/media.functions";
import {
  describeMessageMedia,
  mediaKindLabel,
  type MediaDescriptor,
} from "@/lib/conversations/media.core";
import type { ChatMessage } from "@/lib/conversations";

export function MediaMessage({ message }: { message: ChatMessage }) {
  const descriptor = describeMessageMedia(message);
  if (descriptor.kind === "text") return null;

  return <MediaBody message={message} descriptor={descriptor} />;
}

function MediaBody({
  message,
  descriptor,
}: {
  message: ChatMessage;
  descriptor: MediaDescriptor;
}) {
  const [media, setMedia] = useState<ResolvedMedia | null>(null);
  const [enlarged, setEnlarged] = useState(false);

  const resolve = useMutation({
    mutationFn: () =>
      resolveMessageMedia({
        data: { messageId: message.id, conversationId: message.conversation_id },
      }),
    onSuccess: (result) => setMedia(result),
  });

  const unavailable = !descriptor.resolvable || descriptor.kind === "unknown";

  if (unavailable) {
    return (
      <FallbackCard
        label={mediaKindLabel(descriptor.kind)}
        status={descriptor.status ?? "Media received"}
      />
    );
  }

  const loadButton = (label: string, Icon: typeof Play) => (
    <Button
      size="sm"
      variant="secondary"
      className="gap-2"
      disabled={resolve.isPending}
      onClick={() => resolve.mutate()}
    >
      {resolve.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
      {label}
    </Button>
  );

  return (
    <div className="space-y-2">
      {descriptor.kind === "audio" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Mic className="size-4 shrink-0 opacity-80" />
            <span className="text-xs font-medium uppercase tracking-wide opacity-80">
              Voice note
            </span>
          </div>
          {media ? (
            // Never autoplays — playback is an explicit user action.
            <audio controls preload="none" src={media.dataUrl} className="w-56 max-w-full" />
          ) : (
            loadButton("Play voice note", Play)
          )}
          {descriptor.transcript ? (
            <div className="rounded-lg bg-background/40 px-2.5 py-2 text-xs">
              <p className="mb-1 font-medium uppercase tracking-wide opacity-70">Transcript</p>
              <p className="whitespace-pre-wrap break-words">{descriptor.transcript}</p>
            </div>
          ) : (
            <p className="text-xs opacity-70">Transcription unavailable for this voice note.</p>
          )}
        </div>
      )}

      {descriptor.kind === "image" && (
        <div className="space-y-2">
          {media ? (
            <>
              <button
                type="button"
                onClick={() => setEnlarged(true)}
                className="block overflow-hidden rounded-xl"
                aria-label="Enlarge image"
              >
                <img
                  src={media.dataUrl}
                  alt={descriptor.caption ?? "Image received from the customer"}
                  loading="lazy"
                  className="max-h-64 w-full max-w-xs object-cover"
                />
              </button>
              <Dialog open={enlarged} onOpenChange={setEnlarged}>
                <DialogContent className="max-w-3xl">
                  <DialogTitle className="text-sm">Image received</DialogTitle>
                  <img
                    src={media.dataUrl}
                    alt={descriptor.caption ?? "Image received from the customer"}
                    className="max-h-[75vh] w-full object-contain"
                  />
                </DialogContent>
              </Dialog>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <ImageIcon className="size-4 opacity-80" />
              {loadButton("Show image", Play)}
            </div>
          )}
          {descriptor.caption && (
            <p className="whitespace-pre-wrap break-words text-xs opacity-90">
              {descriptor.caption}
            </p>
          )}
        </div>
      )}

      {descriptor.kind === "document" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg bg-background/40 px-2.5 py-2">
            <FileText className="size-5 shrink-0 opacity-80" />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{descriptor.filename ?? "Document"}</p>
              <p className="text-[10px] uppercase tracking-wide opacity-70">PDF</p>
            </div>
          </div>
          {media ? (
            <a
              href={media.dataUrl}
              download={descriptor.filename ?? "document.pdf"}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-xs font-medium underline"
            >
              <Paperclip className="size-3.5" /> Open document
            </a>
          ) : (
            loadButton("Load document", Play)
          )}
        </div>
      )}

      {resolve.isError && (
        <p className="text-xs opacity-80">{(resolve.error as Error).message}</p>
      )}
    </div>
  );
}

function FallbackCard({ label, status }: { label: string; status: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-background/40 px-2.5 py-2">
      <Paperclip className="mt-0.5 size-4 shrink-0 opacity-70" />
      <div>
        <p className="text-xs font-medium">{label}</p>
        <p className="text-[11px] opacity-70">{status}</p>
      </div>
    </div>
  );
}
