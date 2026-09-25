import { z } from 'zod';

/** Строковые перечисления для SQLite-полей. Источник правды — здесь, а не в схеме БД. */

export const OrgType = z.enum(['UK', 'RSO', 'MUNICIPAL', 'TKO', 'CAPREPAIR_FUND', 'GZHI']);
export type OrgType = z.infer<typeof OrgType>;

export const RequestCategory = z.enum([
  'heating',
  'water',
  'sewerage',
  'electricity',
  'lighting',
  'elevator',
  'roof',
  'entrance',
  'yard',
  'garbage',
  'gas',
  'other',
]);
export type RequestCategory = z.infer<typeof RequestCategory>;

/** cancelled — жилец отозвал заявку сам; rejected — отклонила организация. */
export const RequestStatus = z.enum(['created', 'accepted', 'in_progress', 'completed', 'rejected', 'cancelled']);
export type RequestStatus = z.infer<typeof RequestStatus>;

export const DataSource = z.enum(['gis_zhkh', 'open_data', 'unverified', 'synthetic']);
export type DataSource = z.infer<typeof DataSource>;

export const TariffService = z.enum([
  'heating',
  'cold_water',
  'hot_water',
  'wastewater',
  'electricity',
  'gas',
  'solid_waste',
  'maintenance',
  'capital_repair',
]);
export type TariffService = z.infer<typeof TariffService>;
