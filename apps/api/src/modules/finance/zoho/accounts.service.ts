/**
 * Which accounts money can move between.
 *
 * The legacy integration resolves these at runtime by name: the pay-from side
 * is matched case-insensitively against a list of four, the custody targets
 * are every active account whose parent is "Petty Cash", and the expense
 * account is picked per request from the whole expense chart.
 *
 * Matching by name is the part worth not copying. An account renamed in Zoho
 * silently stops matching, and the failure shows up as a posting that cannot
 * find its account rather than as anything anybody would notice. Here the
 * names are cached with their ids, a person picks from that list, and the
 * **id** is what gets stored on the payment -- so a later rename changes what
 * the account is called and nothing else.
 */
import { Injectable, Logger } from '@nestjs/common';
import { query, one } from '../../../common/db';
import { ZohoBooksClient } from './books-client';

/** Accounts under this parent are where petty cash is held. */
const PETTY_CASH_PARENT = 'Petty Cash';

@Injectable()
export class ZohoAccountsService {
  private readonly log = new Logger('ZohoAccounts');

  constructor(private readonly books: ZohoBooksClient) {}

  /**
   * Refresh the cache from Zoho.
   *
   * Two calls: the bank, cash and credit-card accounts, and the expense chart.
   * Rows are upserted and anything Zoho no longer returns is marked inactive
   * rather than deleted -- a payment made last month points at an account that
   * may since have been archived, and the name should still resolve.
   */
  async sync(): Promise<{
    accounts: number; payFrom: number; custody: number; expense: number;
  }> {
    if (this.books.mode === 'off') {
      throw new Error('The Zoho connection is switched off on this server.');
    }

    const seen = new Set<string>();
    let n = 0;

    /* Bank, cash and credit card: these are the "pay from" side, and the ones
       under Petty Cash are also where custody is held.
    
       Every page, not just the first: Zoho caps a page at 200 rows and a chart
       of accounts longer than that would otherwise lose its tail silently --
       missing from a dropdown rather than from an error. */
    const banking = await this.books.listAll('/bankaccounts', 'bankaccounts',
      { filter_by: 'Status.Active' });
    let banks = 0, expenses = 0;
    for (const a of banking) {
      const isPetty = String(a.parent_account_name ?? '') === PETTY_CASH_PARENT;
      await this.upsert({
        id: a.account_id, name: a.account_name, type: a.account_type,
        parentId: a.parent_account_id ?? null,
        parentName: a.parent_account_name ?? null,
        currency: a.currency_code ?? null,
        payFrom: true,
        /* Every active child of Petty Cash is a custody target. The legacy app
           excludes one by name; that exclusion is a policy about who holds
           cash, so it belongs in the choice a person makes rather than being
           hidden here. */
        custody: isPetty,
        expense: false,
      });
      seen.add(a.account_id); n++; banks++;
    }

    const chart = await this.books.listAll('/chartofaccounts', 'chartofaccounts',
      { filter_by: 'AccountType.Expense' });
    for (const a of chart) {
      await this.upsert({
        id: a.account_id, name: a.account_name, type: 'expense',
        parentId: a.parent_account_id ?? null,
        parentName: a.parent_account_name ?? null,
        currency: a.currency_code ?? null,
        payFrom: false, custody: false, expense: true,
      });
      seen.add(a.account_id); n++; expenses++;
    }

    if (seen.size) {
      const gone = await query<{ account_id: string }>(
        `UPDATE fin_zoho_accounts SET active = false
          WHERE active AND account_id <> ALL($1::text[]) RETURNING account_id`,
        [[...seen]]);
      if (gone.length) {
        this.log.log(`${gone.length} account(s) are no longer active in Zoho`);
      }
    }

    /*
     * Nothing at all is a failure, not a result.
     *
     * A Zoho organisation always has accounts; a sync that finds none means
     * the token is not connected to the organisation it was pointed at --
     * usually because the Self Client was created by somebody without access
     * to Books. Reporting "0 accounts" as success sent people looking for the
     * problem in their chart of accounts, which is the one place it is not.
     */
    /*
     * Nothing at all is a failure, not a result: a Zoho organisation always has
     * accounts.
     *
     * What it does NOT do is say why. An earlier version guessed, from
     * `/organizations` coming back empty, that the account had no access to
     * Books -- but that endpoint needs a scope the posting integration never
     * otherwise uses, so a missing scope read as a missing account. The guess
     * was wrong and cost real time.
     *
     * So it points at the diagnostic, which tries each endpoint and reports
     * what Zoho actually said about each.
     */
    if (n === 0) {
      /* Diagnosed here rather than left for somebody to ask for separately.
         The information exists, the failure is the moment it is wanted, and
         making a person go and fetch it with a bearer token is friction at
         exactly the wrong point. */
      const d = await this.books.diagnose();

      this.log.error('Zoho returned no accounts. What each endpoint answered:');
      this.log.error(`  organisation asked for: ${d.organizationId}  ·  dc: ${d.dataCentre}`);
      for (const p of d.probes) {
        this.log.error(
          `  ${p.endpoint.padEnd(18)} ${p.ok ? 'ok  ' : 'FAIL'}`
          + ` http=${p.httpStatus ?? '-'} code=${p.zohoCode ?? '-'}`
          + ` rows=${p.rows ?? '-'}`
          + (p.message ? `  "${p.message}"` : ''));
      }

      const orgs = d.probes.find((p) => p.endpoint === '/organizations');
      const banks = d.probes.find((p) => p.endpoint === '/bankaccounts');

      throw new Error(
        /* The one inference worth drawing, because it is the only reading
           consistent with Zoho answering successfully and returning nothing:
           the organisation id is not one this token has books for. Zoho does
           not refuse an unknown organisation_id, it simply has nothing to
           return for it -- which is why this looked like an empty company. */
        banks?.ok && banks.rows === 0 && orgs?.ok
          ? `Zoho answered successfully but has no accounts for organisation `
            + `${d.organizationId}. That organisation is probably not the one this `
            + `connection is for — see the /organizations line in the log above for `
            + `the ones it can see, and set ZOHO_ORG to the right id.`
          : 'Zoho returned no accounts. The per-endpoint results are in the server '
            + 'log above: a FAIL line with a code is a scope problem, and an ok line '
            + 'with rows=0 is an organisation problem.');
    }

    /* Broken down, because one total cannot be sanity-checked. A company with
       forty bank accounts and three expense accounts is as wrong as one with
       none, and only the split shows it. */
    const custody = await one<any>(
      `SELECT count(*) AS n FROM fin_zoho_accounts WHERE active AND is_custody`);

    this.log.log(
      `synced ${n} Zoho account(s): ${banks} to pay from `
      + `(${Number(custody?.n ?? 0)} of them petty cash), ${expenses} expense`);
    return {
      accounts: n,
      payFrom: banks,
      custody: Number(custody?.n ?? 0),
      expense: expenses,
    };
  }

  private async upsert(a: {
    id: string; name: string; type: string | null;
    parentId: string | null; parentName: string | null; currency: string | null;
    payFrom: boolean; custody: boolean; expense: boolean;
  }) {
    await query(
      `INSERT INTO fin_zoho_accounts
         (account_id, account_name, account_type, parent_id, parent_name,
          currency_code, active, is_pay_from, is_custody, is_expense, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9, now())
       ON CONFLICT (account_id) DO UPDATE SET
         account_name = EXCLUDED.account_name,
         account_type = EXCLUDED.account_type,
         parent_id    = EXCLUDED.parent_id,
         parent_name  = EXCLUDED.parent_name,
         currency_code = EXCLUDED.currency_code,
         active       = true,
         /* An account can serve more than one purpose and the two calls each
            see part of the picture, so the flags accumulate rather than
            overwrite -- otherwise the second call would clear the first's. */
         is_pay_from  = fin_zoho_accounts.is_pay_from OR EXCLUDED.is_pay_from,
         is_custody   = fin_zoho_accounts.is_custody OR EXCLUDED.is_custody,
         is_expense   = fin_zoho_accounts.is_expense OR EXCLUDED.is_expense,
         synced_at    = now()`,
      [a.id, a.name, a.type, a.parentId, a.parentName, a.currency,
       a.payFrom, a.custody, a.expense]);
  }

  /** The lists a payment form needs, grouped by what each is for. */
  async forPicker() {
    const rows = await query<any>(
      `SELECT account_id, account_name, account_type, parent_name,
              is_pay_from, is_custody, is_expense
         FROM fin_zoho_accounts
        WHERE active
        ORDER BY parent_name NULLS FIRST, account_name`);

    const shape = (r: any) => ({
      id: r.account_id,
      name: r.account_name,
      parentName: r.parent_name,
      type: r.account_type,
    });

    return {
      payFrom: rows.filter((r) => r.is_pay_from).map(shape),
      custody: rows.filter((r) => r.is_custody).map(shape),
      expense: rows.filter((r) => r.is_expense).map(shape),
      syncedAt: rows.length
        ? (await one<any>(`SELECT max(synced_at) AS at FROM fin_zoho_accounts`))?.at ?? null
        : null,
    };
  }

  /**
   * Does this id name an account that may be used this way?
   *
   * Checked when a payment is recorded rather than when it is posted. A wrong
   * account discovered at posting time is a dead queue item hours later, and
   * the person who could have corrected it has long since moved on.
   */
  async check(accountId: string | null | undefined,
              purpose: 'payFrom' | 'custody' | 'expense'): Promise<boolean> {
    if (!accountId) return false;
    const column = purpose === 'payFrom' ? 'is_pay_from'
                 : purpose === 'custody' ? 'is_custody' : 'is_expense';
    const row = await one<any>(
      `SELECT 1 FROM fin_zoho_accounts
        WHERE account_id = $1 AND active AND ${column}`, [accountId]);
    return !!row;
  }

  /** Passed straight through, so the diagnosis lives next to the sync. */
  whoAmI() {
    return this.books.whoAmI();
  }

  /** Raw results from every endpoint the integration uses. */
  diagnose() {
    return this.books.diagnose();
  }

  /** Whether the cache has ever been filled. */
  async ready(): Promise<boolean> {
    const row = await one<any>(`SELECT count(*) AS n FROM fin_zoho_accounts WHERE active`);
    return Number(row?.n ?? 0) > 0;
  }
}