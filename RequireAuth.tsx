import React, { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setAuthed(!!data.session);
      setReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setAuthed(!!session);
    });

    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  if (!ready) return <p style={{ padding:16 }}>Loading…</p>;
  if (!authed) { window.location.hash = '#login'; return null; }
  return <>{children}</>;
}
