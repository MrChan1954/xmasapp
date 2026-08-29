/**
 * `next/navigation`, for the DOM suite.
 *
 * The address bar is the input this provider reads its event id from, so the
 * tests need to be able to set it -- including setting it to an event the
 * reader has just navigated away from, which is what pressing Back does.
 */
export const navigation = {
  pathname: "/",
  replaced: [],
  reset(pathname = "/") { this.pathname = pathname; this.replaced = []; },
};

export function usePathname() {
  return navigation.pathname;
}

export function useRouter() {
  return {
    replace: (href) => navigation.replaced.push(href),
    push: (href) => navigation.replaced.push(href),
    refresh: () => {},
  };
}
