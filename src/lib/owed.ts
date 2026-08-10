export type PurchaseObligation = {
  debtorContributorId: string;
  creditorContributorId: string;
  amountPennies: number;
};

export type SettlementLedgerEntry = {
  payerContributorId: string;
  payeeContributorId: string;
  amountPennies: number;
  voidedAt?: string | null;
};

export type NetOwedBalance = {
  pairKey: string;
  debtorContributorId: string;
  creditorContributorId: string;
  amountPennies: number;
};

export type PairBalanceExplanation = {
  purchaseDirections: PurchaseObligation[];
  purchaseBalance: NetOwedBalance | null;
  paymentAdjustment: NetOwedBalance | null;
  currentBalance: NetOwedBalance | null;
};

export function calculateNetOwedBalances(
  obligations: PurchaseObligation[],
  settlements: SettlementLedgerEntry[],
): NetOwedBalance[] {
  const signedByPair = new Map<string, number>();

  for (const obligation of obligations) {
    validateLedgerAmount(obligation.amountPennies, "Purchase obligation");
    if (obligation.amountPennies === 0 || obligation.debtorContributorId === obligation.creditorContributorId) continue;
    addSigned(
      signedByPair,
      obligation.debtorContributorId,
      obligation.creditorContributorId,
      obligation.amountPennies,
    );
  }

  for (const settlement of settlements) {
    validateLedgerAmount(settlement.amountPennies, "Settlement");
    if (settlement.voidedAt || settlement.amountPennies === 0 || settlement.payerContributorId === settlement.payeeContributorId) continue;
    addSigned(
      signedByPair,
      settlement.payerContributorId,
      settlement.payeeContributorId,
      -settlement.amountPennies,
    );
  }

  return [...signedByPair.entries()]
    .flatMap(([pairKey, signedPennies]) => {
      if (signedPennies === 0) return [];
      const [firstContributorId, secondContributorId] = pairKey.split("|");
      return [{
        pairKey,
        debtorContributorId: signedPennies > 0 ? firstContributorId : secondContributorId,
        creditorContributorId: signedPennies > 0 ? secondContributorId : firstContributorId,
        amountPennies: Math.abs(signedPennies),
      }];
    })
    .sort((left, right) => left.pairKey.localeCompare(right.pairKey));
}

export function contributorOwedSummary(
  balances: NetOwedBalance[],
  contributorId: string,
) {
  return balances.reduce(
    (summary, balance) => {
      if (balance.creditorContributorId === contributorId) summary.owedToYouPennies += balance.amountPennies;
      if (balance.debtorContributorId === contributorId) summary.youOwePennies += balance.amountPennies;
      return summary;
    },
    { owedToYouPennies: 0, youOwePennies: 0 },
  );
}

export function calculatePairBalanceExplanation(
  firstContributorId: string,
  secondContributorId: string,
  obligations: PurchaseObligation[],
  settlements: SettlementLedgerEntry[],
): PairBalanceExplanation {
  if (firstContributorId === secondContributorId) {
    throw new Error("A balance explanation requires two different contributors.");
  }
  const key = pairKey(firstContributorId, secondContributorId);
  const pairObligations = obligations.filter((row) =>
    pairKey(row.debtorContributorId, row.creditorContributorId) === key,
  );
  const pairSettlements = settlements.filter((row) =>
    pairKey(row.payerContributorId, row.payeeContributorId) === key,
  );
  const directionTotals = new Map<string, PurchaseObligation>();
  for (const row of pairObligations) {
    if (row.amountPennies === 0 || row.debtorContributorId === row.creditorContributorId) continue;
    const directionKey = `${row.debtorContributorId}|${row.creditorContributorId}`;
    const existing = directionTotals.get(directionKey);
    const nextAmount = (existing?.amountPennies ?? 0) + row.amountPennies;
    if (!Number.isSafeInteger(nextAmount)) throw new Error("Owed direction total exceeds safe integer limits.");
    directionTotals.set(directionKey, {
      debtorContributorId: row.debtorContributorId,
      creditorContributorId: row.creditorContributorId,
      amountPennies: nextAmount,
    });
  }

  return {
    purchaseDirections: [...directionTotals.values()],
    purchaseBalance: calculateNetOwedBalances(pairObligations, [])[0] ?? null,
    // A payment from A to B reduces A's debt to B, so its balance adjustment
    // points in the opposite direction. This makes direction changes explicit.
    paymentAdjustment: calculateNetOwedBalances([], pairSettlements)[0] ?? null,
    currentBalance: calculateNetOwedBalances(pairObligations, pairSettlements)[0] ?? null,
  };
}

export function pairKey(firstContributorId: string, secondContributorId: string) {
  return [firstContributorId, secondContributorId].sort().join("|");
}

function addSigned(
  signedByPair: Map<string, number>,
  fromContributorId: string,
  toContributorId: string,
  amountPennies: number,
) {
  const [firstContributorId] = [fromContributorId, toContributorId].sort();
  const key = pairKey(fromContributorId, toContributorId);
  const direction = fromContributorId === firstContributorId ? 1 : -1;
  const next = (signedByPair.get(key) ?? 0) + direction * amountPennies;
  if (!Number.isSafeInteger(next)) throw new Error("Owed balance exceeds safe integer limits.");
  signedByPair.set(key, next);
}

function validateLedgerAmount(amountPennies: number, label: string) {
  if (!Number.isSafeInteger(amountPennies) || amountPennies < 0) {
    throw new Error(`${label} must use non-negative integer pennies.`);
  }
}
