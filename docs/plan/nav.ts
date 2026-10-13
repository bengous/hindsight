export type Place = { readonly zone: string | null; readonly node: string | null };

export type NavEvent =
  | { readonly type: "home" }
  | { readonly type: "back" }
  | { readonly type: "zone"; readonly id: string }
  | { readonly type: "node"; readonly id: string };

export const HOME: Place = { zone: null, node: null };

export function navigate(place: Place, ev: NavEvent, zoneOf: (id: string) => string | null): Place {
  switch (ev.type) {
    case "home": {
      return HOME;
    }

    case "zone": {
      return { zone: ev.id, node: null };
    }

    case "node": {
      return { zone: zoneOf(ev.id), node: ev.id };
    }

    case "back": {
      return place.zone !== null && place.node !== null ? { zone: place.zone, node: null } : HOME;
    }

    default: {
      const unknown: never = ev;

      return unknown;
    }
  }
}
