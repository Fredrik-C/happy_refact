export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export class Greeter {
  constructor(private greeting: string) {}

  public greetPerson(name: string): string {
    return `${this.greeting}, ${name}!`;
  }
}

export function calculateDiscount(amount: number, percent: number): number {
  return amount * (percent / 100);
}

export function sumNumbers(numbers: number[]): number {
  return numbers.reduce((acc, curr) => acc + curr, 0);
}
