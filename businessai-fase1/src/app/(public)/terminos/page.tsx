import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPage, Pending, Section } from '@/components/legal'
import { PLAN_CATALOG, TRIAL_DAYS, limitLine } from '@/lib/billing/catalog'

export const metadata: Metadata = {
  title: 'Términos y condiciones · BusinessAI',
  description: 'Términos y condiciones del servicio BusinessAI (borrador preliminar).',
}

export default function TermsPage() {
  return (
    <LegalPage
      title="Términos y condiciones"
      updated="borrador sin fecha de entrada en vigor"
      intro={
        <p>
          Estos términos regulan el uso de BusinessAI, una aplicación web para gestionar los clientes, documentos
          y pagos de una empresa. Al crear una cuenta o contratar un plan aceptas estos términos.
        </p>
      }
    >
      <Section n={1} title="Titular del servicio">
        <p>BusinessAI es un servicio prestado por <Pending>razón social, número de registro, dirección y correo de contacto</Pending>.</p>
      </Section>

      <Section n={2} title="Descripción del servicio">
        <p>
          BusinessAI permite registrar clientes, preparar documentos comerciales con los datos, el logo y la firma
          de tu empresa, imprimirlos o guardarlos en PDF y registrar los pagos recibidos. El servicio se presta a
          través de internet y requiere una cuenta.
        </p>
      </Section>

      <Section n={3} title="Cuenta y acceso">
        <p>
          Eres responsable de la confidencialidad de tu contraseña y de la actividad realizada con tu cuenta. Cada
          empresa puede tener varios usuarios según su plan; solo el propietario o un administrador de la empresa
          puede contratar, cambiar o cancelar la suscripción.
        </p>
        <p>Requisitos para usar el servicio (por ejemplo, edad mínima o uso exclusivamente profesional): <Pending>definir</Pending>.</p>
      </Section>

      <Section n={4} title="Planes y límites">
        <p>Los planes disponibles y sus límites son:</p>
        <ul className="list-disc space-y-1 pl-6">
          {PLAN_CATALOG.map((p) => (
            <li key={p.plan}>
              <strong>{p.name}</strong>: {limitLine(p.maxClients, 'cliente', 'clientes').toLowerCase()},{' '}
              {p.maxDocumentsPerMonth === null ? 'documentos ilimitados' : `${limitLine(p.maxDocumentsPerMonth, 'documento', 'documentos')} por periodo mensual`}{' '}
              y {limitLine(p.maxMembers, 'usuario', 'usuarios').toLowerCase()}.
            </li>
          ))}
        </ul>
        <p>
          Los precios vigentes se muestran en la página de <Link href="/precios" className="underline">Precios</Link> y
          en la aplicación antes de contratar. Al alcanzar el 80 % y el 90 % de un límite se muestra un aviso. Al
          alcanzar el 100 % no se pueden crear nuevos clientes, documentos o usuarios hasta mejorar el plan o, en el
          caso de los documentos, hasta que se reinicie el periodo. Alcanzar un límite nunca borra ni modifica los
          datos existentes.
        </p>
        <p>Modificación de precios y forma de aviso a los clientes: <Pending>definir</Pending>.</p>
      </Section>

      <Section n={5} title="Prueba gratuita">
        <p>
          Todos los planes incluyen una prueba gratuita de {TRIAL_DAYS} días. Para empezarla se solicita una tarjeta de
          crédito o débito, pero no se realiza ningún cobro durante la prueba. Antes de confirmar se muestra la fecha
          del primer cobro. Si no cancelas antes de que termine la prueba, la suscripción se cobra automáticamente
          al terminar la prueba y después cada mes. Cada empresa puede disfrutar de una sola prueba gratuita.
        </p>
      </Section>

      <Section n={6} title="Pagos">
        <p>
          Los pagos se procesan a través de Stripe. BusinessAI no ve ni almacena los datos completos de tu tarjeta.
          La suscripción se renueva automáticamente cada mes hasta que se cancele.
        </p>
        <p>
          Si un cobro falla, Stripe volverá a intentarlo y podrás actualizar tu método de pago desde
          «Plan» → «Administrar suscripción». Mientras la suscripción no esté activa, la cuenta pasa a modo de solo
          lectura: puedes consultar, imprimir y registrar pagos de tus documentos, pero no crear nuevos clientes ni
          documentos.
        </p>
        <p>Impuestos aplicables, incluido el IVU: <Pending>tratamiento contributivo por verificar</Pending>.</p>
      </Section>

      <Section n={7} title="Cambios de plan">
        <p>
          Puedes cambiar de plan desde la página «Plan». Stripe muestra el importe del cambio, con el prorrateo que
          corresponda, antes de que lo confirmes.
        </p>
      </Section>

      <Section n={8} title="Cancelación">
        <p>
          Puedes cancelar en cualquier momento desde «Plan» → «Administrar suscripción». Si cancelas durante la prueba
          gratuita no se realiza ningún cobro. Si cancelas después, la cancelación surte efecto al final del periodo
          ya pagado y conservas el acceso hasta entonces. Después, la cuenta pasa a modo de solo lectura.
        </p>
        <p>Reembolsos: <Pending>definir la política de reembolsos</Pending>.</p>
      </Section>

      <Section n={9} title="Tus datos y contenido">
        <p>
          El tratamiento de los datos personales se describe en la{' '}
          <Link href="/privacidad" className="underline">Política de privacidad</Link>.
        </p>
        <p>Titularidad del contenido introducido, licencia necesaria para prestar el servicio, exportación y conservación tras la cancelación: <Pending>definir</Pending>.</p>
      </Section>

      <Section n={10} title="Uso aceptable">
        <p><Pending>usos prohibidos y consecuencias de su incumplimiento</Pending></p>
      </Section>

      <Section n={11} title="Disponibilidad y responsabilidad">
        <p><Pending>nivel de disponibilidad, garantías y limitación de responsabilidad</Pending></p>
      </Section>

      <Section n={12} title="Suspensión y terminación por parte del titular">
        <p><Pending>supuestos y procedimiento</Pending></p>
      </Section>

      <Section n={13} title="Cambios en estos términos">
        <p><Pending>forma y plazo de aviso de cambios</Pending></p>
      </Section>

      <Section n={14} title="Ley aplicable y jurisdicción">
        <p><Pending>ley aplicable y tribunales competentes</Pending></p>
      </Section>

      <Section n={15} title="Contacto">
        <p><Pending>correo electrónico y dirección de contacto</Pending></p>
      </Section>
    </LegalPage>
  )
}
