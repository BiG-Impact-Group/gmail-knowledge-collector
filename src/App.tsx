import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Session } from '@supabase/supabase-js'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return null
  if (!session) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<div>Login (stub)</div>} />
      <Route path="/accounts" element={
        <ProtectedRoute><div>Accounts (stub)</div></ProtectedRoute>
      } />
      <Route path="/emails" element={
        <ProtectedRoute><div>Emails (stub)</div></ProtectedRoute>
      } />
      <Route path="/" element={<Navigate to="/accounts" replace />} />
    </Routes>
  )
}
