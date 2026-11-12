import Link from 'next/link'
import { PageHeader } from '@/components/ui/page'
import { Flash } from '@/components/accounting-nav'
import { BankNav, NoBankAccess } from '@/components/bank-nav'
import { BankImportWizard } from '@/components/bank-import-wizard'
import { bankPage } from '@/lib/finance/bank-page'
import { bankMessage, type BankAccount } from '@/lib/finance/bank'

export const dynamic = 'force-dynamic'

/** CSV statement import: mapping wizard and preview before confirming. */
export default async function BankImportPage({ searchParams }: { searchParams: Promise<{ account?: string; error?: string }> }) {
  const sp = await searchParams
  const { locale, tr, today, supabase, companyId, access } = await bankPage()
  if (!access.view || !access.manage) return <NoBankAccess tr={tr} unavailable={!access.available} />
  const { data } = await supabase.from('bank_accounts').select('*').eq('company_id', companyId).eq('status', 'active').order('name')
  const accounts = (data ?? []) as BankAccount[]
  const keys = ['account', 'file', 'rows', 'mapping', 'none', 'col_date', 'col_description', 'col_reference', 'col_amount', 'col_debit', 'col_credit', 'col_balance', 'col_txnId',
    'date_format', 'decimal', 'skip', 'invert', 'amount_hint', 'preview', 'valid', 'in', 'out', 'period', 'errors', 'line', 'dups', 'allow_identical', 'confirm', 'confirm_hint',
    'date_invalid', 'date_out_of_range', 'description_missing', 'amount_invalid', 'balance_invalid', 'too_many_rows', 'file_too_large', 'import_invalid',
    'mapping_date', 'mapping_description', 'mapping_amount', 'mapping_column', 'mapping_format'] as const
  const es: Record<(typeof keys)[number], string> = {
    account: 'Cuenta bancaria', file: 'Archivo CSV del banco (máx. 2 MB)', rows: '{n} filas', mapping: 'Columnas', none: '— ninguna —', col_date: 'Fecha', col_description: 'Descripción',
    col_reference: 'Referencia', col_amount: 'Importe (con signo)', col_debit: 'Débito / retiro', col_credit: 'Crédito / depósito', col_balance: 'Saldo', col_txnId: 'ID de transacción',
    date_format: 'Formato de fecha', decimal: 'Formato de importe', skip: 'Líneas antes del encabezado', invert: 'Invertir signo', amount_hint: 'Usa una columna de importe con signo, o bien débito y crédito. Depósitos positivos, retiros negativos.',
    preview: 'Vista previa', valid: 'Movimientos válidos', in: 'Entradas', out: 'Salidas', period: 'Periodo', errors: '{n} filas con errores (no se importa nada hasta corregirlas):', line: 'Línea',
    dups: '{n} filas idénticas a otra del mismo archivo (líneas {lines}). Se omitirán como duplicadas.', allow_identical: 'Son transacciones distintas: importarlas todas',
    confirm: 'Importar {n} movimientos', confirm_hint: 'Al confirmar, el servidor vuelve a leer el archivo y la base de datos omite movimientos ya importados. Un archivo idéntico no se importa dos veces. Importar no cambia ingresos ni gastos.',
    date_invalid: 'fecha no válida', date_out_of_range: 'fecha fuera de rango', description_missing: 'sin descripción', amount_invalid: 'importe no válido', balance_invalid: 'saldo no válido',
    too_many_rows: 'más de 5000 filas', file_too_large: 'El archivo supera 2 MB.', import_invalid: 'El archivo no tiene filas.', mapping_date: 'Indica la columna de fecha.',
    mapping_description: 'Indica la columna de descripción.', mapping_amount: 'Indica una columna de importe, o bien débito y crédito (no ambas).', mapping_column: 'Columna no válida.', mapping_format: 'Formato no válido.',
  }
  const en: Record<(typeof keys)[number], string> = {
    account: 'Bank account', file: 'Bank CSV file (max 2 MB)', rows: '{n} rows', mapping: 'Columns', none: '— none —', col_date: 'Date', col_description: 'Description',
    col_reference: 'Reference', col_amount: 'Amount (signed)', col_debit: 'Debit / withdrawal', col_credit: 'Credit / deposit', col_balance: 'Balance', col_txnId: 'Transaction ID',
    date_format: 'Date format', decimal: 'Amount format', skip: 'Lines before the header', invert: 'Invert sign', amount_hint: 'Use one signed amount column, or debit and credit. Deposits positive, withdrawals negative.',
    preview: 'Preview', valid: 'Valid lines', in: 'Money in', out: 'Money out', period: 'Period', errors: '{n} rows with errors (nothing is imported until fixed):', line: 'Line',
    dups: '{n} rows identical to another of the same file (lines {lines}). They will be skipped as duplicates.', allow_identical: 'They are separate transactions: import them all',
    confirm: 'Import {n} lines', confirm_hint: 'On confirmation the server reads the file again and the database skips lines already imported. An identical file is never imported twice. Importing does not change revenue or expenses.',
    date_invalid: 'invalid date', date_out_of_range: 'date out of range', description_missing: 'no description', amount_invalid: 'invalid amount', balance_invalid: 'invalid balance',
    too_many_rows: 'more than 5000 rows', file_too_large: 'The file is above 2 MB.', import_invalid: 'The file has no rows.', mapping_date: 'Choose the date column.',
    mapping_description: 'Choose the description column.', mapping_amount: 'Choose an amount column, or debit and credit (not both).', mapping_column: 'Invalid column.', mapping_format: 'Invalid format.',
  }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={tr('Bancos', 'Banking')} title={tr('Importar estado bancario', 'Import bank statement')}
        description={tr('Descarga el estado en CSV desde tu banco. Nunca pedimos usuarios ni contraseñas bancarias.', 'Download the statement as CSV from your bank. We never ask for bank usernames or passwords.')} />
      <BankNav tr={tr} current="/bank/import" />
      <Flash error={bankMessage(sp.error, locale)} />
      {accounts.length === 0
        ? <p className="card p-5 text-sm text-muted">{tr('Primero crea una cuenta bancaria.', 'Create a bank account first.')} <Link href="/bank/accounts" className="text-accent">{tr('Ir a cuentas', 'Go to accounts')}</Link></p>
        : <BankImportWizard accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} defaultAccount={accounts.find((a) => a.id === sp.account)?.id ?? accounts[0].id}
            copy={locale === 'en' ? en : es} locale={locale} today={today} />}
    </div>
  )
}
