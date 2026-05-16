import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BannerStack, { BannersProvider, useBanners } from '../BannerStack';
import Banner from '../Banner';

beforeEach(() => {
  try { localStorage.clear(); } catch {}
});

function Pusher({ banners }) {
  const { push } = useBanners();
  React.useEffect(() => {
    banners.forEach((b) => push(b));
  }, [banners, push]);
  return null;
}

describe('BannerStack', () => {
  it('renders nothing when no banners pushed', () => {
    render(
      <BannersProvider>
        <BannerStack />
      </BannersProvider>
    );
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('renders pushed banners', () => {
    render(
      <BannersProvider>
        <BannerStack />
        <Pusher banners={[{ id: 'b1', variant: 'info', message: 'Hello' }]} />
      </BannersProvider>
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('dismisses and persists the dismissal in localStorage', () => {
    render(
      <BannersProvider>
        <BannerStack />
        <Pusher banners={[{ id: 'maint', variant: 'warning', message: 'Down soon' }]} />
      </BannersProvider>
    );
    expect(screen.getByText('Down soon')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Dismiss banner'));
    expect(screen.queryByText('Down soon')).not.toBeInTheDocument();
    expect(localStorage.getItem('bannerDismissed:maint')).toBe('1');
  });

  it('does not re-render a previously dismissed banner', () => {
    localStorage.setItem('bannerDismissed:bx', '1');
    render(
      <BannersProvider>
        <BannerStack />
        <Pusher banners={[{ id: 'bx', variant: 'info', message: 'Skipped' }]} />
      </BannersProvider>
    );
    expect(screen.queryByText('Skipped')).not.toBeInTheDocument();
  });

  it('replaces an existing banner with the same id (upsert)', () => {
    render(
      <BannersProvider>
        <BannerStack />
        <Pusher banners={[
          { id: 'b', variant: 'info', message: 'First' },
          { id: 'b', variant: 'info', message: 'Second' },
        ]} />
      </BannersProvider>
    );
    expect(screen.queryByText('First')).not.toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });
});

describe('Banner', () => {
  it('renders title + message + action', () => {
    const onClick = vi.fn();
    render(<Banner title="Heads up" message="Body text" action={{ label: 'Do it', onClick }} />);
    expect(screen.getByText('Heads up')).toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Do it'));
    expect(onClick).toHaveBeenCalled();
  });

  it('hides the dismiss button when dismissible=false', () => {
    render(<Banner message="X" dismissible={false} />);
    expect(screen.queryByLabelText('Dismiss banner')).not.toBeInTheDocument();
  });
});
