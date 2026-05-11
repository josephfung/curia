// prompts.ts — LLM extraction prompt templates for each extract_as schema.
//
// Each prompt returns instructions for Claude to produce structured JSON from
// raw text or image content. The prompts are separate from the handler to keep
// the handler focused on orchestration.

export type ExtractAs = 'receipt' | 'bank_statement' | 'invoice' | 'raw';

const RECEIPT_PROMPT = `Extract structured data from this receipt or purchase confirmation.
Return ONLY valid JSON matching this exact schema (no markdown fences, no explanation):

{
  "vendor": "<company or merchant name>",
  "amount": <total amount as a number>,
  "currency": "<ISO 4217 currency code, e.g. CAD, USD>",
  "date": "<transaction date as YYYY-MM-DD>",
  "tax": <tax amount as a number, or null if not shown>,
  "line_items": [
    {"description": "<item description>", "amount": <item amount as a number>}
  ]
}

Rules:
- If a field is not visible or cannot be determined, use null
- amount is the total (including tax if applicable)
- currency should be inferred from $ symbols, language, or merchant location if not explicit
- line_items may be empty [] if no itemised breakdown is visible
- Dates should be ISO 8601 (YYYY-MM-DD)`;

const BANK_STATEMENT_PROMPT = `Extract transaction data from this bank or credit card statement.
Return ONLY valid JSON matching this exact schema (no markdown fences, no explanation):

{
  "transactions": [
    {
      "date": "<transaction date as YYYY-MM-DD>",
      "description": "<merchant or transaction description>",
      "amount": <amount as a number — negative for charges/debits, positive for credits/payments>,
      "balance": <running balance as a number, or null if not shown>
    }
  ],
  "account_number": "<last 4 digits of account, or null>",
  "statement_period": "<date range as 'YYYY-MM-DD to YYYY-MM-DD', or null>"
}

Rules:
- Extract ALL transactions visible in the document
- Amounts: use negative for purchases/debits, positive for payments/credits
- Dates should be ISO 8601 (YYYY-MM-DD)
- If the year is not shown on individual transactions, infer from statement period or headers
- Preserve the original transaction description verbatim`;

const INVOICE_PROMPT = `Extract structured data from this invoice.
Return ONLY valid JSON matching this exact schema (no markdown fences, no explanation):

{
  "vendor": "<company or individual who issued the invoice>",
  "invoice_number": "<invoice number or reference, or null>",
  "line_items": [
    {"description": "<line item description>", "quantity": <quantity as number or null>, "unit_price": <price per unit as number or null>, "amount": <line total as number>}
  ],
  "subtotal": <subtotal before tax as a number, or null>,
  "tax": <tax amount as a number, or null>,
  "total": <total amount as a number>,
  "currency": "<ISO 4217 currency code>",
  "due_date": "<due date as YYYY-MM-DD, or null>"
}

Rules:
- If a field is not visible or cannot be determined, use null
- total is the final amount due (including tax)
- currency should be inferred from symbols or context if not explicit`;

/**
 * Get the extraction prompt for the given extract_as schema.
 * Returns null for 'raw' — no LLM extraction needed.
 */
export function getExtractionPrompt(extractAs: ExtractAs): string | null {
  switch (extractAs) {
    case 'receipt': return RECEIPT_PROMPT;
    case 'bank_statement': return BANK_STATEMENT_PROMPT;
    case 'invoice': return INVOICE_PROMPT;
    case 'raw': return null;
  }
}
