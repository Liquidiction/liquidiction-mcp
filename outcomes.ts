export interface OutcomeRaw {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: { name: string }[];
  venue?: string;
}

export interface QuestionRaw {
  question: number;
  name: string;
  description: string;
  fallbackOutcome: number;
  namedOutcomes: number[];
  settledNamedOutcomes?: number[];
}

export interface OutcomeMeta {
  outcomes: OutcomeRaw[];
  questions: QuestionRaw[];
  deployers?: { venue: string; deployer: string }[];
}

export interface Balance {
  coin: string;
  total: string;
  hold?: string;
}

// @N is also an ordinary spot-market identifier. Accept it only when the
// caller explicitly supplies an outcome coin, never when filtering API data.
export function normalizeOutcomeCoin(input: string, explicitInput = false): string | null {
  const match = (explicitInput ? /^(?:[#@+])?(\d+)$/ : /^[#+](\d+)$/).exec(input.trim());
  if (!match) return null;
  const encoded = Number(match[1]);
  if (!Number.isSafeInteger(encoded) || encoded % 10 > 1) return null;
  return `#${encoded}`;
}

export function requestOutcomeCoin(input: string): string {
  const coin = normalizeOutcomeCoin(input, true);
  if (!coin) throw new Error('Expected an outcome coin such as #18660 (side must be 0 or 1).');
  return coin;
}

export function outcomeToCoin(outcomeId: number, side: number): string {
  if (!Number.isSafeInteger(outcomeId) || outcomeId < 0 || (side !== 0 && side !== 1)) {
    throw new Error('Invalid outcome ID or side.');
  }
  return requestOutcomeCoin(String(outcomeId * 10 + side));
}

function finiteNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function markPrice(mids: Record<string, string>, coin: string): number | null {
  const canonical = normalizeOutcomeCoin(coin);
  if (!canonical) return null;
  const price = finiteNumber(mids[canonical] ?? mids[`+${canonical.slice(1)}`]);
  return price !== null && price >= 0 && price <= 1 ? price : null;
}

export function descriptionFields(description: string): Record<string, string> {
  return Object.fromEntries(description.split('|').flatMap(part => {
    const colon = part.indexOf(':');
    return colon > 0 ? [[part.slice(0, colon), part.slice(colon + 1)]] : [];
  }));
}

export function marketContext(meta: OutcomeMeta, outcomeId: number, side: number) {
  const outcome = meta.outcomes.find(item => item.outcome === outcomeId);
  const question = meta.questions.find(item => item.namedOutcomes.includes(outcomeId)
    || item.fallbackOutcome === outcomeId || item.settledNamedOutcomes?.includes(outcomeId));
  const fields = {
    ...descriptionFields(question?.description ?? ''),
    ...descriptionFields(outcome?.description ?? ''),
  };
  const participant = fields.participant ?? (outcome?.name.includes('sportsContestDraw') ? 'Draw' : null);
  const rawSide = outcome?.sideSpecs[side]?.name;
  let selection: string | null = rawSide?.replace(/^template:/, '') ?? null;
  if (selection === '{shortNameA}') selection = fields.participantA ?? fields.shortNameA ?? null;
  else if (selection === '{shortNameB}') selection = fields.participantB ?? fields.shortNameB ?? null;
  else if (participant && selection === 'Yes') selection = participant;
  else if (participant && selection === 'No') selection = `No · ${participant}`;
  else if (selection?.includes('{')) selection = null;
  const matchup = fields.participantA && fields.participantB
    ? `${fields.participantA} v ${fields.participantB}` : null;
  const market = matchup
    ? `${fields.competition ? `${fields.competition}: ` : ''}${matchup}`
    : fields.competition ?? question?.name ?? outcome?.name ?? null;
  return {
    outcomeId, side, market, selection,
    rawOutcomeName: outcome?.name ?? null,
    rawSideName: rawSide ?? null,
    venue: outcome?.venue ?? null,
    deployer: meta.deployers?.find(item => item.venue === outcome?.venue)?.deployer ?? null,
    questionId: question?.question ?? null,
    scheduledStart: fields.scheduledStart ?? null,
    resolutionDeadline: fields.resolutionDeadline ?? null,
    officialSource: fields.officialSource ?? null,
    countedPlay: fields.countedPlay ?? null,
    outcomeDescription: outcome?.description ?? null,
    questionDescription: question?.description ?? null,
  };
}

export function buildPositions(balances: Balance[], mids: Record<string, string>, meta: OutcomeMeta) {
  return balances.flatMap(balance => {
    const coin = normalizeOutcomeCoin(balance.coin);
    const shares = finiteNumber(balance.total);
    if (!coin || shares === null || shares <= 0) return [];
    const encoded = Number(coin.slice(1));
    const held = finiteNumber(balance.hold);
    const heldShares = held !== null && held >= 0 ? held : null;
    const price = markPrice(mids, coin);
    return [{
      ...marketContext(meta, Math.floor(encoded / 10), encoded % 10),
      coin, rawCoin: balance.coin, shares, total: balance.total,
      heldShares,
      unheldShares: heldShares === null ? null : Math.max(0, shares - heldShares),
      markPrice: price,
      markedValue: price === null ? null : shares * price,
    }];
  });
}
