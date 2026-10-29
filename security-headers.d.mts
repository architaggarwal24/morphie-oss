export interface Header { key: string; value: string }
export function pageHeaders(o: { production: boolean }): Header[];
export function apiHeaders(): Header[];
export function allHeaders(o: { production: boolean }): Array<{ source: string; headers: Header[] }>;
