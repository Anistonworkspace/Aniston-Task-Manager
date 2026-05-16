import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Banner from './Banner';

/**
 * BannerStack — global stack of dismissible inline notices below the top bar.
 *
 *   <BannerStack />                                  // mount once at layout level
 *   const { push, dismiss } = useBanners();          // imperative API
 *   push({ id: 'maintenance-2026-05-16', variant: 'warning', message: '...' });
 *
 * - Dismissal persists per banner id in localStorage (`bannerDismissed:<id>`).
 *   A banner with the same id never re-appears on subsequent reloads unless
 *   the user explicitly calls `resetDismissed(id)`.
 * - Multiple banners stack vertically in insertion order.
 * - Built on top of the existing AttentionBox visual primitive.
 *
 * The provider lives at the layout level (Layout.jsx). For ambient banners
 * driven by socket events or app state, push from anywhere via useBanners().
 */

const BannersContext = createContext(null);

const STORAGE_PREFIX = 'bannerDismissed:';

function isDismissed(id) {
  if (!id) return false;
  try { return localStorage.getItem(STORAGE_PREFIX + id) === '1'; }
  catch { return false; }
}

function markDismissed(id) {
  if (!id) return;
  try { localStorage.setItem(STORAGE_PREFIX + id, '1'); } catch {}
}

function clearDismissed(id) {
  if (!id) return;
  try { localStorage.removeItem(STORAGE_PREFIX + id); } catch {}
}

export function BannersProvider({ children }) {
  const [banners, setBanners] = useState([]);

  const push = useCallback((banner) => {
    if (!banner || !banner.id) return;
    if (isDismissed(banner.id)) return;
    setBanners((prev) => {
      // Upsert by id — re-pushing replaces the prior entry in place.
      const next = prev.filter((b) => b.id !== banner.id);
      next.push(banner);
      return next;
    });
  }, []);

  const dismiss = useCallback((id) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
    markDismissed(id);
  }, []);

  const remove = useCallback((id) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const resetDismissed = useCallback((id) => clearDismissed(id), []);

  const value = useMemo(
    () => ({ banners, push, dismiss, remove, resetDismissed }),
    [banners, push, dismiss, remove, resetDismissed]
  );

  return <BannersContext.Provider value={value}>{children}</BannersContext.Provider>;
}

export function useBanners() {
  const ctx = useContext(BannersContext);
  if (!ctx) throw new Error('useBanners must be used inside <BannersProvider>');
  return ctx;
}

export default function BannerStack({ className = '' }) {
  const ctx = useContext(BannersContext);

  // Allow BannerStack to be mounted with or without the provider — if no
  // provider is present, the stack is inert (renders nothing). This makes it
  // safe to land the component before the provider is wired in Layout.jsx.
  const banners = ctx?.banners || [];
  const dismiss = ctx?.dismiss;

  if (banners.length === 0) return null;

  return (
    <div
      className={`flex flex-col flex-shrink-0 ${className}`}
      role="region"
      aria-label="System notifications"
    >
      {banners.map((b) => (
        <Banner
          key={b.id}
          variant={b.variant || 'info'}
          title={b.title}
          message={b.message}
          action={b.action}
          dismissible={b.dismissible !== false}
          onDismiss={() => dismiss?.(b.id)}
        />
      ))}
    </div>
  );
}

// Helper for the rare case where you need to mount BannerStack without a provider
// and inject banners imperatively (e.g. tests). Most callers want BannersProvider.
export function useEphemeralBannerSeed(items) {
  const ctx = useContext(BannersContext);
  useEffect(() => {
    if (!ctx || !items?.length) return;
    items.forEach((b) => ctx.push(b));
  }, [ctx, items]);
}
