import { createStripeGateway, type StripeConfig, type StripeGateway } from "./stripe";

// Un cliente del SDK por clave secreta, reusado entre requests (el SDK mantiene sus
// conexiones). Si la clave cambia (rotación con reinicio), se arma uno nuevo.
let cached: { key: string; gateway: StripeGateway } | null = null;

export function stripeGatewayFor(config: Pick<StripeConfig, "secretKey">): StripeGateway {
  if (!cached || cached.key !== config.secretKey) cached = { key: config.secretKey, gateway: createStripeGateway(config) };
  return cached.gateway;
}
