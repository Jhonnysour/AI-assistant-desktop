import { defineConfig } from 'vitest/config';

// Las pruebas cubren el ViewModel (con un puente falso) y el cliente de main (contra un
// servidor HTTP simulado); ninguna necesita Electron ni un DOM.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
