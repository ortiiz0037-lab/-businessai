import { redirect } from 'next/navigation'
import { isPlanKey } from '@/lib/billing/catalog'

/** /register → /signup (keeps a valid ?plan=). */
export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan } = await searchParams
  redirect(isPlanKey(plan) ? `/signup?plan=${plan}` : '/signup')
}
