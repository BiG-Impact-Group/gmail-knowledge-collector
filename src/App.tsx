import React, { lazy, Suspense, useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import type { Session } from '@supabase/supabase-js'
import LoginPage from '@/components/auth/LoginPage'

const AccountsPage = lazy(() => import('@/components/accounts/AccountsPage'))
const EmailPage = lazy(() => import('@/components/email/EmailPage'))
const DocumentsPage = lazy(() => import('@/components/documents/DocumentsPage'))
const SearchPage = lazy(() => import('@/components/search/SearchPage'))

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return null
  if (!session) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/accounts" element={
          <ProtectedRoute><AccountsPage /></ProtectedRoute>
        } />
        <Route path="/emails" element={
          <ProtectedRoute><EmailPage /></ProtectedRoute>
        } />
        <Route path="/documents" element={
          <ProtectedRoute><DocumentsPage /></ProtectedRoute>
        } />
        <Route path="/ask" element={
          <ProtectedRoute><SearchPage /></ProtectedRoute>
        } />
        <Route path="/" element={<Navigate to="/accounts" replace />} />
      </Routes>
    </Suspense>
  )
}
