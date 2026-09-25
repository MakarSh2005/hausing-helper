/** Проверка контрольной цифры ИНН юрлица (10 цифр). Номер с неверной цифрой ФНС не выдаёт. */
export function isValidOrgInn(inn: string): boolean {
  if (!/^\d{10}$/.test(inn)) return false;
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = w.reduce((acc, k, i) => acc + k * Number(inn[i]), 0);
  return (sum % 11) % 10 === Number(inn[9]);
}
