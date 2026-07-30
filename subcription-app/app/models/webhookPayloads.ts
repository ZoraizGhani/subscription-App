/**
 * Shapes of the webhook payloads this app subscribes to. Every field is optional:
 * Shopify can add and reshape payload fields between API versions, and handlers
 * should degrade rather than throw when something is missing.
 *
 * These payloads are informational. Anything that matters is re-read from the
 * Admin API using the ids below.
 */

export interface SubscriptionContractWebhookPayload {
  id?: number;
  admin_graphql_api_id?: string;
  admin_graphql_api_customer_id?: string;
  status?: string;
}

export interface BillingAttemptWebhookPayload {
  id?: number;
  admin_graphql_api_id?: string;
  order_id?: number;
  admin_graphql_api_order_id?: string;
  subscription_contract_id?: number;
  admin_graphql_api_subscription_contract_id?: string;
  amount?: string | number;
  currency?: string;
  error_code?: string | null;
  error_message?: string | null;
  ready?: boolean;
  created_at?: string;
}

export interface OrderWebhookPayload {
  id?: number;
  admin_graphql_api_id?: string;
  name?: string;
  total_price?: string | number;
  currency?: string;
  processed_at?: string;
}