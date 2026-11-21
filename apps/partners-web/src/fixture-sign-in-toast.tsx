'use client';
import { useEffect, useState } from 'react';
import { StaffToast, formatToastText, getStaffToastTiming } from '@vintad3e/ui/toast';

export function FixtureSignInToast({ notice }: { notice: { title: string; message: string } }) {
  const [phase, setPhase] = useState<'visible' | 'leaving' | 'hidden'>('visible');
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('error');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    const { durationMs, leaveMs } = getStaffToastTiming('error');
    let removal: ReturnType<typeof setTimeout> | undefined;
    const dismissal = setTimeout(() => { setPhase('leaving'); removal = setTimeout(() => setPhase('hidden'), leaveMs); }, durationMs);
    return () => { clearTimeout(dismissal); if (removal !== undefined) clearTimeout(removal); };
  }, []);
  return phase === 'hidden' ? null : <div className="staff-toast-stack"><StaffToast tone="error" leaving={phase === 'leaving'} className="staff-sign-in-toast"><strong>{formatToastText(notice.title)}</strong><span>{formatToastText(notice.message)}</span></StaffToast></div>;
}
