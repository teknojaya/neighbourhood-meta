import { DEFAULT_RADIUS_KM, MAX_RADIUS_KM, MIN_RADIUS_KM, RADIUS_OPTIONS_KM, type UiLanguage } from '@neighbourhood/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { useMe, useSaveProfile } from '../../auth/useMe';
import { Alert, Button, Card, PageHeading, Skeleton, TextField } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { BookmarkIcon, BoxIcon, ChevronRightIcon, GiftIcon, MapIcon, PinIcon, UserIcon } from '../../components/icons';
import { ProfileLocationDialog } from './ProfileLocationDialog';

export function ProfilePage() {
  const { signOut, linkGoogle } = useAuth();
  const [linkState, setLinkState] = useState<'idle' | 'linked' | 'error'>('idle');
  const me = useMe();
  const save = useSaveProfile();
  const online = useOnline();

  const [displayName, setDisplayName] = useState('');
  const [radius, setRadius] = useState(String(DEFAULT_RADIUS_KM));
  const [language, setLanguage] = useState<UiLanguage>('en');
  const [locationOpen, setLocationOpen] = useState(false);

  const profile = me.data?.profile;
  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.displayName ?? '');
    setRadius(String(profile.searchRadiusKm));
    setLanguage(profile.preferredLanguage);
  }, [profile]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate({
      displayName: displayName.trim(),
      // Location changes only through the confirmed location form; keep what is saved.
      areaLabel: profile?.areaLabel ?? null,
      homeLocation: profile?.homeLocation ?? null,
      searchRadiusKm: Number(radius),
      preferredLanguage: language,
    });
  }

  return (
    <div className="space-y-4">
      <PageHeading title={profile?.displayName ? t('profile.title') : t('profile.setupTitle')}>Your neighbourhood, preferences and account.</PageHeading>
      {profile && <section className="flex items-center gap-3 border-b border-stone-200 pb-4"><span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xl font-semibold text-brand-800">{profile.displayName?.slice(0, 1).toUpperCase() || <UserIcon />}</span><div className="min-w-0"><h2 className="break-words font-semibold">{profile.displayName || 'Set up your profile'}</h2><p className="break-words text-sm text-stone-600">{me.data?.email}</p></div></section>}
      <nav aria-label="Your neighbourhood" className="divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white px-4">
        {[
          { to: '/saved-items', label: 'Saved items', detail: 'Goods you want to come back to', icon: BookmarkIcon },
          { to: '/activity?tab=giving', label: 'My shared items', detail: 'Manage your donations and lending', icon: GiftIcon },
          { to: '/needs/saved', label: 'Saved needs', detail: 'Things you are still looking for', icon: BookmarkIcon },
          { to: '/communities', label: 'Communities & points', detail: 'Your groups and local collection points', icon: MapIcon },
          { to: '/categories', label: 'Product categories', detail: 'Browse by the kind of item', icon: BoxIcon },
        ].map(({ to, label, detail, icon: Icon }) => <Link key={to} to={to} className="flex min-h-16 items-center gap-3 py-3 hover:text-brand-800"><span className="text-brand-700"><Icon /></span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{label}</span><span className="block text-sm text-stone-600">{detail}</span></span><span className="text-stone-500"><ChevronRightIcon /></span></Link>)}
      </nav>
      <section className="space-y-2 border-b border-stone-200 py-3"><h2 className="flex items-center gap-2 font-semibold"><PinIcon />Your search area</h2><p className="text-sm text-stone-600">{profile?.homeLocation ? `${profile.areaLabel || 'Location set'} · within ${profile.searchRadiusKm} km` : 'Set a location to discover items nearby.'}</p><p className="text-sm text-stone-600">Your exact home location stays private.</p><Button type="button" variant="secondary" onClick={() => setLocationOpen(true)}>Choose location</Button></section>
      {locationOpen && <ProfileLocationDialog onClose={() => setLocationOpen(false)} onSaved={() => setLocationOpen(false)} />}
      {profile && !profile.displayName && <Alert tone="info">{t('profile.needsName')}</Alert>}
      {me.isError && <Alert tone="error">{t('error.generic')}</Alert>}
      {me.isPending && <Skeleton cards={2} />}

      <Card>
        <details open={!profile?.displayName || undefined}>
        <summary className="cursor-pointer py-1 font-semibold">Edit profile & preferences</summary>
        <form className="space-y-4" onSubmit={onSubmit}>
          <h2 className="pt-4 text-sm font-semibold text-stone-600">Profile details</h2>
          <TextField label={t('auth.displayName')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} minLength={2} maxLength={60} required />

          <fieldset className="space-y-2 border-t border-stone-200 pt-4">
            <legend className="text-sm font-medium">{t('profile.radius')}</legend>
            <div className="grid grid-cols-4 gap-2">
              {RADIUS_OPTIONS_KM.map((km) => (
                <label key={km} className={`flex min-h-11 cursor-pointer items-center justify-center rounded-xl text-sm font-semibold ring-1 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-700 ${Number(radius) === km ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white ring-stone-300'}`}>
                  <input type="radio" name="radius" value={km} checked={Number(radius) === km} onChange={() => setRadius(String(km))} className="sr-only" />
                  {t('profile.radiusOption', { km })}
                </label>
              ))}
            </div>
          </fieldset>

          <TextField label="Custom search radius (km)" type="number" inputMode="numeric" min={MIN_RADIUS_KM} max={MAX_RADIUS_KM} step={1} required value={radius} onChange={event => setRadius(event.target.value)} hint="Enter 1–50 km, in whole kilometres." />
          <label className="block space-y-1">
            <span className="text-sm font-medium">Preferred language for Ask</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value as UiLanguage)} className="block min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3">
              <option value="en">English</option>
              <option value="id">Bahasa Indonesia</option>
            </select>
            <span className="block text-sm text-stone-600">Ask supports English and Bahasa Indonesia. App menus currently use English.</span>
          </label>

          {!online && <Alert tone="warning">{t('error.OFFLINE')}</Alert>}
          {save.isError && (
            <Alert tone="error">{save.error instanceof ApiError && save.error.code === 'VALIDATION_FAILED' ? t('error.VALIDATION_FAILED') : t('error.generic')}</Alert>
          )}
          {save.isSuccess && <Alert tone="success">{t('profile.saved')}</Alert>}
          <Button type="submit" className="w-full" disabled={save.isPending || !online}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </form>
        </details>
      </Card>

      {me.data && (
        <Card className="text-sm">
          <p className="font-medium">{t('profile.roles')}</p>
          <p className="text-stone-600">
            {[...new Set([...me.data.platformRoles, ...me.data.memberships.map(m => m.role)])].map(role => role.replaceAll('_', ' ')).join(', ') || 'Neighbour'}
          </p>
          <Link to="/communities" className="inline-flex min-h-11 items-center font-semibold text-brand-800 underline">View your community roles</Link>
        </Card>
      )}

      {me.data?.signInMethod === 'email_otp' && (
        <Card className="space-y-2 text-sm">
          <Button
            variant="secondary"
            className="w-full"
            disabled={!online}
            onClick={() =>
              void linkGoogle().then(
                () => setLinkState('linked'),
                () => setLinkState('error'),
              )
            }
          >
            {t('auth.linkGoogle')}
          </Button>
          {linkState === 'linked' && <Alert tone="success">{t('auth.linked')}</Alert>}
          {linkState === 'error' && <Alert tone="error">{t('auth.error.generic')}</Alert>}
        </Card>
      )}

      <Button variant="secondary" className="w-full" onClick={() => void signOut()}>
        {t('common.signOut')}
      </Button>
    </div>
  );
}
