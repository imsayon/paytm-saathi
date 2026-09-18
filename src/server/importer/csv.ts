import crypto from "node:crypto";
import { AppError } from "../errors";

export const REQUIRED_COLUMNS = [
  "merchant_id",
  "customer_id",
  "paid_at",
  "amount_minor",
  "status",
  "consent",
] as const;

export const PAYMENT_STATES = ["settled", "refunded", "duplicate"] as const;
export const CONSENT_STATES = ["true", "false", "unknown"] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];
export type ConsentState = (typeof CONSENT_STATES)[number];

export type ParsedRow = {
  rowNumber: number;
  merchantId: string;
  customerId: string;
  customerName: string;
  contactRef: string | null;
  consent: ConsentState;
  paymentId: string;
  paidAt: string;
  amountMinor: number;
  status: PaymentState;
};

export type ParseResult = {
  rows: ParsedRow[];
  checksum: string;
  idStrategy: "file_payment_id" | "derived_id";
};

/** Minimal RFC4180 reader: quoted fields, escaped quotes, CRLF tolerant. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * A leading =, +, - or @ makes spreadsheet software execute the cell. Imported
 * text is untrusted, so it is neutralised rather than stored as written.
 */
function sanitizeText(value: string): string {
  const trimmed = value.trim();
  return /^[=+\-@\t\r]/.test(trimmed) ? `'${trimmed}` : trimmed;
}

function derivePaymentId(row: Omit<ParsedRow, "paymentId" | "rowNumber">): string {
  const material = `${row.merchantId}|${row.customerId}|${row.paidAt}|${row.amountMinor}|${row.status}`;
  return `derived_${crypto.createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

export function parseCsv(content: string, options: { maxRows: number }): ParseResult {
  const checksum = crypto.createHash("sha256").update(content).digest("hex");
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new AppError("BAD_REQUEST", "CSV file is empty.");
  }

  const header = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new AppError("BAD_REQUEST", `CSV is missing required columns: ${missing.join(", ")}.`, {
      missing_columns: missing,
    });
  }

  const dataLines = lines.slice(1);
  if (dataLines.length > options.maxRows) {
    throw new AppError("BAD_REQUEST", `CSV has ${dataLines.length} rows; the limit is ${options.maxRows}.`);
  }

  const hasPaymentIdColumn = header.includes("payment_id");
  const index = (column: string) => header.indexOf(column);
  const rows: ParsedRow[] = [];
  const seenPaymentIds = new Set<string>();

  dataLines.forEach((line, offset) => {
    const rowNumber = offset + 2;
    const fields = splitCsvLine(line);
    const read = (column: string): string => {
      const at = index(column);
      return at === -1 ? "" : sanitizeText(fields[at] ?? "");
    };

    const merchantId = read("merchant_id");
    const customerId = read("customer_id");
    const paidAtRaw = read("paid_at");
    const amountRaw = read("amount_minor");
    const status = read("status").toLowerCase();
    const consent = read("consent").toLowerCase();
    const contactRef = read("contact_ref");
    const customerName = read("customer_name") || customerId;

    if (!merchantId || !customerId) {
      throw new AppError("BAD_REQUEST", `Row ${rowNumber}: merchant_id and customer_id are required.`, {
        row: rowNumber,
      });
    }

    const paidAtMs = Date.parse(paidAtRaw);
    if (Number.isNaN(paidAtMs)) {
      throw new AppError("BAD_REQUEST", `Row ${rowNumber}: paid_at "${paidAtRaw}" is not a valid timestamp.`, {
        row: rowNumber,
      });
    }

    if (!/^\d+$/.test(amountRaw)) {
      throw new AppError(
        "BAD_REQUEST",
        `Row ${rowNumber}: amount_minor must be a non-negative integer in paise, received "${amountRaw}".`,
        { row: rowNumber },
      );
    }

    if (!(PAYMENT_STATES as readonly string[]).includes(status)) {
      throw new AppError(
        "BAD_REQUEST",
        `Row ${rowNumber}: status "${status}" must be one of ${PAYMENT_STATES.join(", ")}.`,
        { row: rowNumber },
      );
    }

    if (!(CONSENT_STATES as readonly string[]).includes(consent)) {
      throw new AppError(
        "BAD_REQUEST",
        `Row ${rowNumber}: consent "${consent}" must be one of ${CONSENT_STATES.join(", ")}.`,
        { row: rowNumber },
      );
    }

    const base = {
      merchantId,
      customerId,
      customerName,
      contactRef: contactRef || null,
      consent: consent as ConsentState,
      paidAt: new Date(paidAtMs).toISOString(),
      amountMinor: Number.parseInt(amountRaw, 10),
      status: status as PaymentState,
    };

    const paymentId = hasPaymentIdColumn ? read("payment_id") : derivePaymentId(base);
    if (!paymentId) {
      throw new AppError("BAD_REQUEST", `Row ${rowNumber}: payment_id column is present but empty.`, {
        row: rowNumber,
      });
    }
    if (seenPaymentIds.has(paymentId)) {
      throw new AppError("BAD_REQUEST", `Row ${rowNumber}: duplicate payment_id "${paymentId}" within the file.`, {
        row: rowNumber,
      });
    }
    seenPaymentIds.add(paymentId);

    rows.push({ rowNumber, paymentId, ...base });
  });

  return {
    rows,
    checksum,
    idStrategy: hasPaymentIdColumn ? "file_payment_id" : "derived_id",
  };
}
