import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Bot, MessageSquarePlus, User } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app/PageHeader";
import { useCopy } from "@/lib/i18n/dict";
import { WORKSPACE_COPY } from "@/lib/i18n/app/workspace.i18n";
import { SearchInput } from "@/components/app/SearchInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  chatDay,
  createConversation,
  fetchConversations,
  fetchMyAgencyId,
} from "@/lib/conversations";

export const Route = createFileRoute("/_authenticated/conversations/")({
  head: () => ({
    meta: [
      { title: "AI Inbox — UMRAIO" },
      {
        name: "description",
        content:
          "WhatsApp-style inbox where the UMRAIO AI Autonomous Business Executive answers Umrah enquiries, qualifies leads and recommends packages.",
      },
      { property: "og:title", content: "AI Inbox — UMRAIO" },
      {
        property: "og:description",
        content: "AI-handled Umrah enquiries, qualification and package recommendations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ConversationsPage,
});

function ConversationsPage() {
  const t = useCopy(WORKSPACE_COPY).conversationsList;
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: conversations = [], isLoading } = useQuery({
    queryKey: ["conversations"],
    queryFn: fetchConversations,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const agencyId = await fetchMyAgencyId();
      if (!agencyId) throw new Error(t.noAgencyError);
      return createConversation({ agencyId, fullName: name.trim(), phone: phone.trim() || null });
    },
    onSuccess: (id) => {
      setOpen(false);
      setName("");
      setPhone("");
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      navigate({ to: "/conversations/$conversationId", params: { conversationId: id } });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const filtered = conversations.filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      (c.lead?.full_name ?? "").toLowerCase().includes(q) ||
      (c.lead?.phone ?? "").toLowerCase().includes(q) ||
      c.preview.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        description={t.description}
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <MessageSquarePlus className="size-4" /> {t.newConversation}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t.startConversation}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="c-name">{t.customerName}</Label>
                  <Input
                    id="c-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t.customerNamePlaceholder}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="c-phone">{t.whatsappNumber}</Label>
                  <Input
                    id="c-phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder={t.whatsappNumberPlaceholder}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => createMutation.mutate()}
                  disabled={!name.trim() || createMutation.isPending}
                >
                  {createMutation.isPending ? t.creating : t.create}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <SearchInput
        value={search}
        onChange={setSearch}
        label={t.searchLabel}
        placeholder={t.searchPlaceholder}
      />

      <div className="panel divide-y divide-border/60 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-sm text-muted-foreground">{t.loading}</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-sm text-muted-foreground">
            {t.empty}
          </div>
        ) : (
          filtered.map((c) => (
            <Link
              key={c.id}
              to="/conversations/$conversationId"
              params={{ conversationId: c.id }}
              className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/40"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
                <User className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">
                    {c.lead?.full_name ?? t.unknownContact}
                  </span>
                  {c.ai_enabled && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                      <Bot className="size-3" /> AI
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                  {c.preview}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {chatDay(c.last_message_at)}
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
