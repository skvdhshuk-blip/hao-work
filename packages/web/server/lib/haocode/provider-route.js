// HaoCode provider routing. Magpie spreads a request over a provider's keys
// or across a group's models (order, rotate, priority). This is that choice
// for the providers Hao Work already has: a saved list, not a second gateway.

export const PROVIDER_ROUTE_STRATEGIES = Object.freeze(['order', 'rotate', 'priority']);

export const emptyProviderRoute = () => ({
  enabled: false,
  preferRoute: false,
  strategy: 'order',
  cursor: 0,
  members: [],
});

const memberOf = (value) => {
  if (!value || typeof value !== 'object') return null;
  const providerID = typeof value.providerID === 'string' ? value.providerID.trim() : '';
  const modelID = typeof value.modelID === 'string' ? value.modelID.trim() : '';
  if (!providerID || !modelID) return null;
  const parsed = Number(value.priority);
  return {
    providerID,
    modelID,
    priority: Number.isFinite(parsed) ? Math.max(0, Math.min(1000, Math.trunc(parsed))) : 0,
  };
};

export const normalizeProviderRoute = (value) => {
  const empty = emptyProviderRoute();
  if (!value || typeof value !== 'object') return empty;
  const members = (Array.isArray(value.members) ? value.members : [])
    .map(memberOf)
    .filter(Boolean)
    .slice(0, 20);
  const cursor = Number.isInteger(value.cursor) && value.cursor >= 0 ? value.cursor : 0;
  return {
    enabled: value.enabled === true,
    preferRoute: value.preferRoute === true,
    strategy: PROVIDER_ROUTE_STRATEGIES.includes(value.strategy) ? value.strategy : 'order',
    cursor,
    members,
  };
};

export const orderRouteMembers = (route) => {
  const members = route.members;
  if (route.strategy === 'priority') {
    return [...members].sort((left, right) => right.priority - left.priority
      || left.providerID.localeCompare(right.providerID)
      || left.modelID.localeCompare(right.modelID));
  }
  if (route.strategy === 'rotate' && members.length > 0) {
    const start = route.cursor % members.length;
    return [...members.slice(start), ...members.slice(0, start)];
  }
  return [...members];
};

/**
 * Pick the provider/model a prompt should use.
 * `available` is the set of provider ids that already have a key.
 * An explicit chat model stays first unless the route says to prefer itself.
 */
export const pickProviderRoute = ({ route, requested, available }) => {
  const normalized = normalizeProviderRoute(route);
  const requestedChoice = {
    providerID: requested?.providerID || '',
    modelID: requested?.modelID || '',
  };
  if (!normalized.enabled || normalized.members.length === 0 || !requestedChoice.providerID) {
    return { choice: requestedChoice, route: normalized, advanced: false };
  }
  const ready = (providerID) => available.has(providerID);
  const ordered = orderRouteMembers(normalized).filter((member) => ready(member.providerID));
  if (!normalized.preferRoute && ready(requestedChoice.providerID)) {
    return { choice: requestedChoice, route: normalized, advanced: false };
  }
  if (ordered.length === 0) {
    return { choice: requestedChoice, route: normalized, advanced: false };
  }
  return {
    choice: { providerID: ordered[0].providerID, modelID: ordered[0].modelID },
    route: normalized.strategy === 'rotate'
      ? { ...normalized, cursor: (normalized.cursor + 1) % normalized.members.length }
      : normalized,
    advanced: normalized.strategy === 'rotate',
  };
};
