import { createContext, useContext } from 'react';

interface MobileMenuState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const MobileMenuContext = createContext<MobileMenuState>({
  open: false,
  setOpen: () => undefined,
});

export function useMobileMenu(): MobileMenuState {
  return useContext(MobileMenuContext);
}
