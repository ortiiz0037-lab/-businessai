import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC = ['/login', '/signup', '/auth']

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(list) {
          list.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    },
  )

  // getClaims valida el JWT localmente; cada página del servidor re-verifica con getUser().
  const { data } = await supabase.auth.getClaims()
  const isAuthed = !!data?.claims
  const path = request.nextUrl.pathname
  const isPublic = PUBLIC.some((p) => path === p || path.startsWith(p + '/'))

  const redirectTo = (to: string, next?: string) => {
    const url = request.nextUrl.clone()
    url.pathname = to
    url.search = next ? `?next=${encodeURIComponent(next)}` : ''
    const res = NextResponse.redirect(url)
    response.cookies.getAll().forEach((c) => res.cookies.set(c))
    return res
  }

  if (!isAuthed && !isPublic) return redirectTo('/login', path === '/' ? undefined : path)
  if (isAuthed && (path === '/login' || path === '/signup')) return redirectTo('/dashboard')

  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
