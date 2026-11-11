import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Páginas públicas: autenticación y páginas informativas (precios y textos legales).
const PUBLIC = ['/login', '/signup', '/register', '/forgot-password', '/invite', '/clock/link', '/kiosk', '/auth', '/precios', '/terminos', '/privacidad']
// Página principal pública (solo la ruta exacta "/").
const PUBLIC_EXACT = ['/']

// Rutas llamadas por servicios externos sin sesión de usuario. Cada una se
// autentica por su cuenta (Stripe: verificación de la firma `stripe-signature`).
const MACHINE_ROUTES = ['/api/stripe/webhook']

// `?lang=es|en` on any page (e.g. coming from the public site) is remembered
// for the app in the same cookie the language selector writes.
const LOCALE_COOKIE = 'ba_locale'
const LOCALE_COOKIE_OPTIONS = { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' as const, httpOnly: true }

export async function updateSession(request: NextRequest) {
  // Sin cookies, sin redirección: el webhook valida la firma de Stripe.
  if (MACHINE_ROUTES.includes(request.nextUrl.pathname)) {
    return NextResponse.next({ request })
  }

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
  const isPublic = PUBLIC_EXACT.includes(path) || PUBLIC.some((p) => path === p || path.startsWith(p + '/'))

  const lang = request.nextUrl.searchParams.get('lang')
  const rememberLang = (res: NextResponse) => {
    if ((lang === 'es' || lang === 'en') && request.cookies.get(LOCALE_COOKIE)?.value !== lang) {
      res.cookies.set(LOCALE_COOKIE, lang, LOCALE_COOKIE_OPTIONS)
    }
    return res
  }

  const redirectTo = (to: string, next?: string) => {
    const url = request.nextUrl.clone()
    url.pathname = to
    url.search = next ? `?next=${encodeURIComponent(next)}` : ''
    const res = NextResponse.redirect(url)
    response.cookies.getAll().forEach((c) => res.cookies.set(c))
    return rememberLang(res)
  }

  if (!isAuthed && !isPublic) return redirectTo('/login', path)
  if (isAuthed && (path === '/login' || path === '/signup')) return redirectTo('/dashboard')

  response.headers.set('Cache-Control', 'private, no-store')
  return rememberLang(response)
}
