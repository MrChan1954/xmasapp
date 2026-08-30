const pound = String.fromCharCode(163);

export const formatPennies = (pennies: number) => {
  if (!Number.isSafeInteger(pennies)) {
    throw new Error("Money must be formatted from an integer number of pennies.");
  }
  const absolutePennies = Math.abs(pennies);
  const pounds = Math.floor(absolutePennies / 100).toLocaleString("en-GB");
  const pence = absolutePennies % 100;
  return `${pennies < 0 ? "-" : ""}${pound}${pounds}${pence === 0 ? "" : `.${pence.toString().padStart(2, "0")}`}`;
};

export const formatPounds = (pounds: number) => formatPennies(Math.round(pounds * 100));

/**
 * Pennies as the string an editable money field holds.
 *
 * The inverse of what a person types, not of `formatPennies`. A form field's
 * value is a raw number a `<input inputMode="decimal">` will accept and
 * `parseMoneyToPennies` will read back, so it carries **no currency symbol and
 * no thousands separator** — `formatPennies` adds both, and putting either one
 * into an input makes the field un-parseable the moment it is submitted
 * unedited.
 *
 * Whole pounds lose their `.00` so a £30 budget opens as `30` rather than
 * `30.00`, which is what somebody about to retype it expects to see.
 *
 * Unlike `formatPennies` this does NOT throw on a non-integer. Every caller
 * feeds it an integer penny column straight from the database, and a field that
 * refused to render would take a whole screen down; the parse on the way back
 * out is where invalid money is caught.
 */
export const priceInput = (pennies: number) => (pennies / 100).toFixed(2).replace(/\.00$/u, "");
