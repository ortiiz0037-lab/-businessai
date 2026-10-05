import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/dashboard') // el proxy envía a /login si no hay sesión
}
