
import { NextResponse } from "next/server";
import Stripe from "stripe";
import {
  createClient as createSupabaseClient,
} from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const priceId = process.env.STRIPE_PRICE_ID;

  if (
    !secretKey ||
    !webhookSecret ||
    !serviceKey ||
    !supabaseUrl ||
    !priceId
  ) {
    return NextResponse.json(
      { error: "Falta configurar Stripe o Supabase." },
      { status: 500 }
    );
  }

  const stripe = new Stripe(secretKey);

  const supabase = createSupabaseClient(
    supabaseUrl,
    serviceKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );

  // 1. Validar firma de Stripe
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Falta la firma de Stripe." },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    const body = await request.text();

    event = stripe.webhooks.constructEvent(
      body,
      signature,
      webhookSecret
    );
  } catch {
    return NextResponse.json(
      { error: "Firma de Stripe inválida." },
      { status: 400 }
    );
  }

  // 2. Guardar suscripción de la empresa.
  // Se define dentro de POST para conservar el tipo inferido
  // del cliente Supabase, sin utilizar any.
  async function saveSubscription(
    subscription: Stripe.Subscription,
    companyId: string,
    expectedPriceId: string
  ) {
    const item = subscription.items.data[0];

    if (!item) {
      throw new Error(
        "La suscripción no contiene productos."
      );
    }

    const actualPriceId = item.price.id;

    if (actualPriceId !== expectedPriceId) {
      throw new Error("El Price ID no coincide.");
    }

    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;

    const { error } = await supabase
      .from("company_subscriptions")
      .upsert(
        {
          company_id: companyId,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscription.id,
          stripe_price_id: actualPriceId,
          plan: "pro",
          status: subscription.status,
        },
        {
          onConflict: "company_id",
        }
      );

    if (error) {
      throw error;
    }
  }

  try {
    // 3. Comprobar eventos duplicados
    const { data: existing, error: lookupError } =
      await supabase
        .from("stripe_events")
        .select("id")
        .eq("id", event.id)
        .maybeSingle();

    if (lookupError) {
      throw lookupError;
    }

    if (existing) {
      return NextResponse.json({
        received: true,
        duplicate: true,
      });
    }

    // 4. Checkout completado
    if (event.type === "checkout.session.completed") {
      const session =
        event.data.object as Stripe.Checkout.Session;

      const companyId =
        session.metadata?.company_id ??
        session.client_reference_id;

      if (!companyId || !session.subscription) {
        throw new Error(
          "Checkout sin company_id o subscription."
        );
      }

      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription.id;

      const subscription =
        await stripe.subscriptions.retrieve(
          subscriptionId
        );

      await saveSubscription(
        subscription,
        companyId,
        priceId
      );
    }

    // 5. Cambios y cancelaciones de suscripción
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription =
        event.data.object as Stripe.Subscription;

      const companyId =
        subscription.metadata?.company_id;

      if (!companyId) {
        throw new Error(
          "No se encontró company_id."
        );
      }

      await saveSubscription(
        subscription,
        companyId,
        priceId
      );
    }

    // 6. Pagos de facturas
    if (
      event.type === "invoice.paid" ||
      event.type === "invoice.payment_failed"
    ) {
      const invoice =
        event.data.object as unknown as {
          subscription?: string | { id: string } | null;
          parent?: {
            subscription_details?: {
              subscription?: string | { id: string } | null;
            } | null;
          } | null;
        };

      const subscriptionRef =
        invoice.parent?.subscription_details?.subscription ??
        invoice.subscription;

      const subscriptionId =
        typeof subscriptionRef === "string"
          ? subscriptionRef
          : subscriptionRef?.id;

      if (subscriptionId) {
        const subscription =
          await stripe.subscriptions.retrieve(
            subscriptionId
          );

        const companyId =
          subscription.metadata?.company_id;

        if (!companyId) {
          throw new Error(
            "Suscripción sin company_id."
          );
        }

        await saveSubscription(
          subscription,
          companyId,
          priceId
        );
      }
    }

    // 7. Registrar evento procesado
    const { error: eventError } = await supabase
      .from("stripe_events")
      .insert({
        id: event.id,
        event_type: event.type,
        processed_at: new Date().toISOString(),
      });

    if (eventError) {
      throw eventError;
    }

    return NextResponse.json({
      received: true,
      processed: true,
    });

  } catch (error) {
    console.error("Stripe webhook error:", error);

    return NextResponse.json(
      {
        error: "Error procesando el evento de Stripe.",
      },
      { status: 500 }
    );
  }
}
