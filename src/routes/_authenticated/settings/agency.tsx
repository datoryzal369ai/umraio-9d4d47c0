import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Building2, Clock, ImagePlus, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { settingsCopy } from "@/lib/i18n/app/settings.i18n";
import { useCopy } from "@/lib/i18n/dict";
import {
  DAYS,
  DEFAULT_HOURS,
  fetchAgency,
  fetchSettings,
  signedLogoUrl,
  updateAgency,
  updateSettings,
  uploadAgencyLogo,
  type BusinessHours,
  type DayKey,
} from "@/lib/settings";

export const Route = createFileRoute("/_authenticated/settings/agency")({
  head: () => ({
    meta: [
      { title: "Agency Settings — UMRAIO Autonomous AI Business Executive" },
      {
        name: "description",
        content:
          "Manage your Umrah agency profile, logo, contact details and business hours for the UMRAIO Autonomous AI Business Executive.",
      },
      { property: "og:title", content: "Agency Settings — UMRAIO" },
      {
        property: "og:description",
        content: "Agency profile, logo, business hours and WhatsApp number.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AgencySettingsPage,
});

function Panel({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Building2;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel space-y-4 p-5">
      <header className="flex items-start gap-3">
        <div className="rounded-xl border border-border/60 bg-surface p-2.5">
          <Icon className="size-4 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-base font-semibold tracking-tight">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function AgencySettingsPage() {
  const copy = useCopy(settingsCopy).agency;
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const { data: agency, isLoading } = useQuery({ queryKey: ["agency"], queryFn: fetchAgency });
  const { data: settings } = useQuery({
    queryKey: ["agency-settings", agency?.id],
    queryFn: () => fetchSettings(agency!.id),
    enabled: Boolean(agency?.id),
  });
  const { data: logoUrl } = useQuery({
    queryKey: ["agency-logo", agency?.logo_url],
    queryFn: () => signedLogoUrl(agency?.logo_url ?? null),
    enabled: Boolean(agency?.logo_url),
  });

  const [profile, setProfile] = useState({
    name: "",
    registration_no: "",
    contact_email: "",
    contact_phone: "",
    website: "",
    address: "",
    country: "Malaysia",
    timezone: "Asia/Kuala_Lumpur",
  });
  const [hours, setHours] = useState<BusinessHours>(DEFAULT_HOURS);

  useEffect(() => {
    if (!agency) return;
    setProfile({
      name: agency.name ?? "",
      registration_no: agency.registration_no ?? "",
      contact_email: agency.contact_email ?? "",
      contact_phone: agency.contact_phone ?? "",
      website: agency.website ?? "",
      address: agency.address ?? "",
      country: agency.country ?? "Malaysia",
      timezone: agency.timezone ?? "Asia/Kuala_Lumpur",
    });
  }, [agency]);

  useEffect(() => {
    if (settings?.business_hours) setHours({ ...DEFAULT_HOURS, ...settings.business_hours });
  }, [settings]);

  const saveProfile = useMutation({
    mutationFn: async () => {
      if (!agency) throw new Error(copy.toasts.agencyNotLoaded);
      if (!profile.name.trim()) throw new Error(copy.toasts.nameRequired);
      return updateAgency(agency.id, {
        name: profile.name.trim().slice(0, 120),
        registration_no: profile.registration_no.trim() || null,
        contact_email: profile.contact_email.trim() || null,
        contact_phone: profile.contact_phone.trim() || null,
        website: profile.website.trim() || null,
        address: profile.address.trim() || null,
        country: profile.country.trim() || "Malaysia",
        timezone: profile.timezone.trim() || "Asia/Kuala_Lumpur",
      });
    },
    onSuccess: () => {
      toast.success(copy.toasts.profileSaved);
      queryClient.invalidateQueries({ queryKey: ["agency"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveHours = useMutation({
    mutationFn: async () => {
      if (!settings) throw new Error(copy.toasts.settingsNotLoaded);
      return updateSettings(settings.id, { business_hours: hours });
    },
    onSuccess: () => {
      toast.success(copy.toasts.hoursSaved);
      queryClient.invalidateQueries({ queryKey: ["agency-settings"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      if (!agency) throw new Error(copy.toasts.agencyNotLoaded);
      if (file.size > 3 * 1024 * 1024) throw new Error(copy.toasts.logoTooLarge);
      const path = await uploadAgencyLogo(agency.id, file);
      return updateAgency(agency.id, { logo_url: path });
    },
    onSuccess: () => {
      toast.success(copy.toasts.logoUpdated);
      queryClient.invalidateQueries({ queryKey: ["agency"] });
      queryClient.invalidateQueries({ queryKey: ["agency-logo"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const setDay = (key: DayKey, patch: Partial<BusinessHours[DayKey]>) =>
    setHours({ ...hours, [key]: { ...hours[key], ...patch } });

  if (isLoading || !agency) return <Skeleton className="h-[520px] rounded-2xl" />;

  return (
    <div className="space-y-6">
      <Panel icon={ImagePlus} title={copy.logo.title} description={copy.logo.description}>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-20 items-center justify-center overflow-hidden rounded-2xl border border-border bg-surface">
            {logoUrl ? (
              <img src={logoUrl} alt={`${agency.name} logo`} className="size-full object-contain" />
            ) : (
              <Building2 className="size-7 text-muted-foreground" />
            )}
          </div>
          <div className="space-y-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadLogo.mutate(file);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              onClick={() => fileInput.current?.click()}
              disabled={uploadLogo.isPending}
            >
              {uploadLogo.isPending ? copy.logo.uploading : copy.logo.uploadLogo}
            </Button>
            <p className="text-xs text-muted-foreground">{copy.logo.hint}</p>
          </div>
        </div>
      </Panel>

      <Panel
        icon={Building2}
        title={copy.profile.title}
        description={copy.profile.description}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">{copy.profile.name}</Label>
            <Input
              id="name"
              maxLength={120}
              value={profile.name}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reg">{copy.profile.registration}</Label>
            <Input
              id="reg"
              maxLength={60}
              value={profile.registration_no}
              onChange={(e) => setProfile({ ...profile, registration_no: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">{copy.profile.email}</Label>
            <Input
              id="email"
              type="email"
              maxLength={255}
              value={profile.contact_email}
              onChange={(e) => setProfile({ ...profile, contact_email: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phone">{copy.profile.phone}</Label>
            <Input
              id="phone"
              maxLength={30}
              value={profile.contact_phone}
              onChange={(e) => setProfile({ ...profile, contact_phone: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="website">{copy.profile.website}</Label>
            <Input
              id="website"
              maxLength={255}
              placeholder="https://"
              value={profile.website}
              onChange={(e) => setProfile({ ...profile, website: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">{copy.profile.timezone}</Label>
            <Input
              id="timezone"
              maxLength={60}
              value={profile.timezone}
              onChange={(e) => setProfile({ ...profile, timezone: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="address">{copy.profile.address}</Label>
            <Textarea
              id="address"
              rows={3}
              maxLength={500}
              value={profile.address}
              onChange={(e) => setProfile({ ...profile, address: e.target.value })}
            />
          </div>
        </div>
        <Button onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending}>
          {saveProfile.isPending ? copy.profile.saving : copy.profile.save}
        </Button>
      </Panel>

      <Panel
        icon={Clock}
        title={copy.hours.title}
        description={copy.hours.description}
      >
        <div className="space-y-2">
          {DAYS.map((day) => {
            const value = hours[day.key];
            return (
              <div
                key={day.key}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3"
              >
                <span className="w-24 text-sm font-medium">{day.label}</span>
                <Switch
                  checked={!value.closed}
                  onCheckedChange={(checked) => setDay(day.key, { closed: !checked })}
                  aria-label={copy.hours.openAria.replace("{day}", day.label)}
                />
                {value.closed ? (
                  <span className="text-xs text-muted-foreground">{copy.hours.closed}</span>
                ) : (
                  <div className="flex items-center gap-2">
                    <Input
                      type="time"
                      className="w-32"
                      value={value.open}
                      onChange={(e) => setDay(day.key, { open: e.target.value })}
                    />
                    <span className="text-xs text-muted-foreground">{copy.hours.to}</span>
                    <Input
                      type="time"
                      className="w-32"
                      value={value.close}
                      onChange={(e) => setDay(day.key, { close: e.target.value })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <Button onClick={() => saveHours.mutate()} disabled={saveHours.isPending || !settings}>
          {saveHours.isPending ? copy.hours.saving : copy.hours.save}
        </Button>
      </Panel>

      <Panel
        icon={MessageCircle}
        title={copy.whatsapp.title}
        description={copy.whatsapp.description}
      >
        <p className="text-sm text-muted-foreground">
          {copy.whatsapp.note}
        </p>
        <Button asChild variant="outline">
          <Link to="/settings/whatsapp">{copy.whatsapp.open}</Link>
        </Button>
      </Panel>
    </div>
  );
}
