import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPage, Pending, Section } from '@/components/legal'

export const metadata: Metadata = {
  title: 'Política de privacidad · BusinessAI',
  description: 'Política de privacidad de BusinessAI (borrador preliminar).',
}

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Política de privacidad"
      updated="borrador sin fecha de entrada en vigor"
      intro={
        <p>
          Esta política explica qué datos personales trata BusinessAI, para qué los usa y con qué proveedores
          trabaja para prestar el servicio.
        </p>
      }
    >
      <Section n={1} title="Responsable del tratamiento">
        <p><Pending>razón social, dirección y correo de contacto del responsable</Pending></p>
      </Section>

      <Section n={2} title="Datos que tratamos">
        <ul className="list-disc space-y-2 pl-6">
          <li><strong>Datos de tu cuenta:</strong> nombre, correo electrónico y contraseña. La contraseña la gestiona nuestro proveedor de autenticación; BusinessAI no la ve.</li>
          <li><strong>Datos de tu empresa:</strong> los que introduces en «Mi empresa», como el nombre, los datos de contacto, el logo y la imagen de la firma.</li>
          <li><strong>Datos de tus clientes, documentos y pagos:</strong> la información que registras en la aplicación para preparar documentos y llevar el control de los pagos.</li>
          <li><strong>Datos de la suscripción:</strong> plan, estado de la suscripción, fechas de la prueba y de facturación, y los identificadores de cliente y suscripción en Stripe. Los datos de la tarjeta los recoge y guarda Stripe; BusinessAI no tiene acceso a ellos.</li>
          <li><strong>Datos técnicos:</strong> las cookies necesarias para mantener tu sesión iniciada.</li>
        </ul>
        <p>Respecto de los datos de tus clientes que introduces en la aplicación, papel de cada parte (responsable o encargado): <Pending>definir</Pending>.</p>
      </Section>

      <Section n={3} title="Para qué los usamos">
        <ul className="list-disc space-y-1 pl-6">
          <li>Prestar el servicio: guardar y mostrar tus clientes, documentos y pagos.</li>
          <li>Gestionar tu suscripción, la prueba gratuita, los cobros y los límites de tu plan.</li>
          <li>Enviarte los correos necesarios para la cuenta, como la confirmación del registro.</li>
          <li>Proteger el servicio y separar los datos de cada empresa.</li>
        </ul>
        <p>Base jurídica de cada tratamiento y envío de comunicaciones comerciales: <Pending>definir</Pending>.</p>
      </Section>

      <Section n={4} title="Proveedores">
        <p>Para prestar el servicio trabajamos con estos proveedores:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li><strong>Supabase:</strong> base de datos, autenticación y almacenamiento de archivos (logo y firma).</li>
          <li><strong>Vercel:</strong> alojamiento de la aplicación web.</li>
          <li><strong>Stripe:</strong> procesamiento de pagos y gestión de la suscripción.</li>
        </ul>
        <p>Ubicación de los datos y transferencias internacionales: <Pending>verificar con cada proveedor y completar</Pending>.</p>
      </Section>

      <Section n={5} title="Seguridad">
        <p>
          La aplicación se sirve mediante conexiones cifradas (HTTPS). Los datos de cada empresa están separados
          mediante controles de acceso en la base de datos, de modo que un usuario solo accede a los datos de las
          empresas de las que es miembro. Las imágenes de firma se guardan en un almacenamiento privado y solo se
          muestran mediante enlaces temporales.
        </p>
      </Section>

      <Section n={6} title="Cookies">
        <p>
          Actualmente la aplicación utiliza cookies necesarias para iniciar y mantener la sesión.
          Uso de herramientas de analítica u otras cookies: <Pending>confirmar antes de publicar</Pending>.
        </p>
      </Section>

      <Section n={7} title="Conservación">
        <p><Pending>plazos de conservación durante la suscripción y tras la cancelación</Pending></p>
      </Section>

      <Section n={8} title="Tus derechos">
        <p><Pending>derechos aplicables y cómo ejercerlos (acceso, rectificación, eliminación, etc.)</Pending></p>
      </Section>

      <Section n={9} title="Menores">
        <p><Pending>definir</Pending></p>
      </Section>

      <Section n={10} title="Cambios en esta política">
        <p><Pending>forma de aviso de cambios</Pending></p>
      </Section>

      <Section n={11} title="Contacto">
        <p>
          <Pending>correo electrónico de contacto para privacidad</Pending>. Consulta también los{' '}
          <Link href="/terminos" className="underline">Términos y condiciones</Link>.
        </p>
      </Section>
    </LegalPage>
  )
}
