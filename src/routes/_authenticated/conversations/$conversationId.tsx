import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CalendarCheck, Loader2, Send, Sparkle, User, UserRound } from "lucide-react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/brand/BrandLogo";
import { useCopy } from "@/lib/i18n/dict";
import { WORKSPACE_COPY } from "@/lib/i18n/app/workspace.i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  chatDay,
  chatTime,
  fetchConversation,
  fetchMessages,
  insertMessage,
  setAiEnabled,
  type ChatMessage,
  type ConversationIntelligenceSnapshot,
} from "@/lib/conversations";
import { aiReplyToConversation, conversationInsights } from "@/lib/sales-ai.functions";

export const Route = createFileRoute("/_authenticated/conversations/$conversationId")({
  head: () => ({
    meta: [
      { title: "Conversation — UMRAIO AI Autonomous Business Executive" },
      {
        name: "description",
        content:
          "WhatsApp-style conversation handled by the UMRAIO AI Autonomous Business Executive with live qualification, package recommendations and booking suggestions.",
      },
      { property: "og:title", content: "Conversation — UMRAIO AI Autonomous Business Executive" },
      {
        property: "og:description",
        content: "AI replies, conversation summary, follow-up drafts and booking suggestions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  errorComponent: ({ error }) => (
    <div role="alert" className="panel p-8 text-sm text-destructive">
      {error.message}
    </div>
  ),
  component: ConversationPage,
});

function ConversationPage() {
  const t = useCopy(WORKSPACE_COPY).conversation;
  const { conversationId } = Route.useParams();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [asHuman, setAsHuman] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { data: conversation } = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => fetchConversation(conversationId),
  });

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => fetchMessages(conversationId),
  });

  const insights = useMutation({
    mutationFn: () => conversationInsights({ data: { conversationId } }),
    onError: (error: Error) => toast.error(error.message),
  });

  const send = useMutation({
    mutationFn: async (body: string) => {
      if (!conversation) throw new Error(t.conversationNotLoadedError);
      await insertMessage(
        conversationId,
        conversation.agency_id,
        asHuman ? "human" : "customer",
        body,
      );
      await queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      if (asHuman || !conversation.ai_enabled) return;
      const { reply, errorCode } = await aiReplyToConversation({ data: { conversationId } });
      if (errorCode === "AI_CREDITS_EXHAUSTED") {
        throw new Error(t.aiCreditsExhaustedError);
      }
      if (!reply) throw new Error(t.aiNoReplyError);
      await insertMessage(conversationId, conversation.agency_id, "ai", reply);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      inputRef.current?.focus();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const aiToggle = useMutation({
    mutationFn: (enabled: boolean) => setAiEnabled(conversationId, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, [conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, send.isPending]);

  function submit() {
    const body = draft.trim();
    if (!body || send.isPending) return;
    setDraft("");
    send.mutate(body);
  }

  const lead = conversation?.lead;
  const grouped = groupByDay(messages);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="panel flex h-[calc(100dvh-11rem)] min-h-[520px] flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b border-border/60 bg-card/60 px-4 py-3">
          <Button asChild variant="ghost" size="icon" className="min-h-11 min-w-11 xl:hidden">
            <Link to="/conversations" aria-label={t.backToInbox}>
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
            <User className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{lead?.full_name ?? t.unknownContact}</p>
            <p className="truncate text-xs text-muted-foreground">
              {lead?.phone ?? t.noNumber} · WhatsApp
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="ai-toggle" className="hidden text-xs text-muted-foreground sm:block">
              {t.aiExecutive}
            </Label>
            <Switch
              id="ai-toggle"
              checked={conversation?.ai_enabled ?? false}
              onCheckedChange={(v) => aiToggle.mutate(v)}
            />
          </div>
        </header>

        <div ref={scrollRef} className="chat-canvas flex-1 space-y-4 overflow-y-auto px-4 py-5">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t.loadingMessages}</p>
          ) : messages.length === 0 ? (
            <p className="mx-auto max-w-sm rounded-xl bg-muted/40 p-4 text-center text-sm text-muted-foreground">
              {t.emptyMessages}
            </p>
          ) : (
            grouped.map(([day, items]) => (
              <div key={day} className="space-y-2">
                <div className="flex justify-center">
                  <span className="rounded-full bg-muted/60 px-3 py-1 text-[11px] text-muted-foreground">
                    {day}
                  </span>
                </div>
                {items.map((m) => (
                  <Bubble key={m.id} message={m} />
                ))}
              </div>
            ))
          )}
          {send.isPending && !asHuman && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> {t.aiTyping}
            </div>
          )}
        </div>

        <footer className="border-t border-border/60 bg-card/60 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Switch id="as-human" checked={asHuman} onCheckedChange={setAsHuman} />
            <Label htmlFor="as-human" className="text-xs font-normal">
              {asHuman ? t.replyingAsHuman : t.sendingAsCustomer}
            </Label>
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder={t.messagePlaceholder}
              className="max-h-32 min-h-11 resize-none"
            />
            <Button
              size="icon"
              className="size-11 shrink-0"
              onClick={submit}
              disabled={!draft.trim() || send.isPending}
              aria-label={t.sendMessage}
            >
              {send.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </div>
        </footer>
      </section>

      <aside className="space-y-4">
        <SalesIntelligencePanel snapshot={conversation?.intelligence ?? null} />
        <div className="panel p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t.aiExecutiveBrief}
            </h2>
            <Button
              size="sm"
              variant="secondary"
              className="gap-2"
              onClick={() => insights.mutate()}
              disabled={insights.isPending}
            >
              {insights.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkle className="size-3.5" />
              )}
              {t.generate}
            </Button>
          </div>

          {insights.data ? (
            <div className="mt-4 space-y-4 text-sm">
              <Insight label={t.insightSummary} value={insights.data.summary} />
              <Insight label={t.insightCustomerProfile} value={insights.data.customer_profile} />
              <Insight label={t.insightQualification} value={insights.data.qualification} />
              <Insight label={t.insightObjections} value={insights.data.objections} />
              <Insight label={t.insightNextStep} value={insights.data.next_step} />
              <div className="rounded-xl border border-primary/25 bg-primary/5 p-3">
                <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-primary">
                  <CalendarCheck className="size-3.5" /> {t.bookingSuggestion}
                </p>
                <p className="mt-1.5 text-sm">{insights.data.booking_suggestion}</p>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t.followUpDraft}
                </p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm">
                  {insights.data.followup_message}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => {
                    setDraft(insights.data!.followup_message);
                    setAsHuman(true);
                    inputRef.current?.focus();
                  }}
                >
                  {t.useAsReply}
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              {t.generatePrompt}
            </p>
          )}
        </div>

        {lead && (
          <div className="panel p-5 text-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t.lead}
            </h2>
            <p className="mt-3 font-medium">{lead.full_name}</p>
            <p className="text-muted-foreground">{t.stage}: {lead.stage}</p>
            <Button asChild variant="outline" size="sm" className="mt-3 gap-2">
              <Link to="/leads/$leadId" params={{ leadId: lead.id }}>
                <UserRound className="size-3.5" /> {t.openLeadRecord}
              </Link>
            </Button>
          </div>
        )}
      </aside>
    </div>
  );
}

function Insight({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1">{value}</p>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const t = useCopy(WORKSPACE_COPY).conversation;
  const outbound = message.sender !== "customer";
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm",
          outbound
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-card text-card-foreground ring-1 ring-border/60",
        )}
      >
        {outbound && (
          <p
            className={cn(
              "mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide",
              "opacity-80",
            )}
          >
            {message.sender === "ai" ? (
              <>
                <AssistantAvatar size={14} /> {t.aiExecutiveLabel}
              </>
            ) : (
              <>
                <UserRound className="size-3" /> {t.agent}
              </>
            )}
          </p>
        )}
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        <p className={cn("mt-1 text-right text-[10px]", outbound ? "opacity-70" : "opacity-60")}>
          {chatTime(message.created_at)}
        </p>
      </div>
    </div>
  );
}

const HUMANISED: Record<string, string> = {
  ASK_CLARIFYING_QUESTION: "Ask a clarifying question",
  RECOMMEND_PACKAGE: "Recommend a package",
  EXPLAIN_VALUE: "Explain package value",
  HANDLE_OBJECTION: "Handle the objection",
  PROVIDE_COMPARISON: "Compare the options",
  BUILD_TRUST: "Build trust",
  CREATE_QUOTATION: "Create a quotation",
  SEND_QUOTATION: "Send the quotation",
  FOLLOW_UP: "Follow up",
  MOVE_TO_DEPOSIT_READY: "Move to deposit",
  ESCALATE: "Escalate to a colleague",
  NURTURE: "Nurture",
  STOP: "Hold — human handling",
  ANSWER_FROM_CONTEXT: "Answer from what is already known",
  SIMPLIFY_OPTIONS: "Simplify the options",
  SUPPORT_DECISION_MAKER: "Support their decision process",
  REDUCE_FRICTION: "Remove the last blocker",
};

const STRATEGY_LABEL: Record<string, string> = {
  MOVE_TO_CLOSE: "Move to close",
  VALUE_CLARIFICATION: "Clarify value",
  PACKAGE_ALTERNATIVE: "Offer an alternative",
  BUILD_TRUST: "Build trust",
  SIMPLIFY_CHOICES: "Simplify choices",
  SUPPORT_DECISION_PROCESS: "Support decision process",
  REDUCE_FRICTION: "Reduce friction",
  FACILITATE_BOOKING: "Facilitate booking",
  REPAIR_EXPERIENCE: "Repair experience",
  STOP_CONTACT: "Stop contact",
  HUMAN_ASSIST: "Human assist",
  UNDERSTAND_NEED: "Understand the need",
};

function SalesIntelligencePanel({
  snapshot,
}: {
  snapshot: ConversationIntelligenceSnapshot | null;
}) {
  const t = useCopy(WORKSPACE_COPY).conversation;
  if (!snapshot?.state) return null;
  const chips: Array<{ label: string; value: string }> = [
    { label: t.stageChip, value: snapshot.state.replaceAll("_", " ").toLowerCase() },
    snapshot.language ? { label: t.languageChip, value: snapshot.language.toUpperCase() } : null,
    snapshot.style ? { label: t.styleChip, value: snapshot.style.replaceAll("_", " ") } : null,
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  return (
    <div className="panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {t.salesIntelligence}
      </h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {chips.map((c) => (
          <span
            key={c.label}
            className="rounded-full bg-primary/10 px-3 py-1 text-[11px] font-medium capitalize text-primary"
          >
            {c.label}: {c.value}
          </span>
        ))}
        {typeof snapshot.quality_score === "number" && (
          <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
            {t.conversationQuality}: {snapshot.quality_score}/100
          </span>
        )}
      </div>
      {snapshot.next_best_action && (
        <p className="mt-3 text-sm">
          <span className="text-muted-foreground">{t.nextBestAction}: </span>
          {HUMANISED[snapshot.next_best_action] ?? snapshot.next_best_action}
        </p>
      )}
      {snapshot.objection_memory?.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t.objectionsRaised}: {snapshot.objection_memory.join(", ").toLowerCase().replaceAll("_", " ")}
        </p>
      ) : null}
      {snapshot.buying_signals?.length ? (
        <p className="mt-1 text-xs text-chart-4">
          {t.buyingSignals}: {snapshot.buying_signals.join(", ").toLowerCase().replaceAll("_", " ")}
        </p>
      ) : null}
      {snapshot.missing?.length ? (
        <p className="mt-1 text-xs text-muted-foreground">{t.stillUnknown}: {snapshot.missing.join(", ")}</p>
      ) : null}
      {snapshot.behavior?.strategy ? (
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t.behaviouralRead}
          </p>
          <p className="mt-2 text-sm">
            <span className="text-muted-foreground">{t.strategy}: </span>
            {STRATEGY_LABEL[snapshot.behavior.strategy] ?? snapshot.behavior.strategy}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {[
              [t.readiness, snapshot.behavior.decision_readiness?.value],
              [t.trust, snapshot.behavior.trust?.value],
              [t.hesitation, snapshot.behavior.hesitation?.value],
              [t.priceSensitivity, snapshot.behavior.price_sensitivity?.value],
              [t.closingReadiness, snapshot.behavior.closing_readiness?.value],
            ]
              .filter(([, v]) => v && v !== "UNKNOWN" && v !== "NONE")
              .map(([label, v]) => (
                <span
                  key={label as string}
                  className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium capitalize text-muted-foreground"
                >
                  {label}: {String(v).replaceAll("_", " ").toLowerCase()}
                </span>
              ))}
          </div>
          {snapshot.behavior.decision_maker_dependency && snapshot.behavior.decision_makers?.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t.waitingOn}: {snapshot.behavior.decision_makers.join(", ").toLowerCase()}
            </p>
          ) : null}
          {snapshot.behavior.value_dimensions?.length ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t.caresAbout}: {snapshot.behavior.value_dimensions.join(", ").toLowerCase().replaceAll("_", " ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function groupByDay(messages: ChatMessage[]): Array<[string, ChatMessage[]]> {
  const map = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const key = chatDay(m.created_at);
    const list = map.get(key) ?? [];
    list.push(m);
    map.set(key, list);
  }
  return Array.from(map.entries());
}
