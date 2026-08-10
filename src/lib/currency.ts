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
