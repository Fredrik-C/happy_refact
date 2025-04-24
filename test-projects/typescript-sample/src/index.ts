import { greet, Greeter } from './greeter';

function runGreetingExamples() {
  const message1 = greet("World");
  console.log(message1);

  const greeterInstance = new Greeter("Hi");
  const message2 = greeterInstance.greetPerson("Alice");
  console.log(message2);
}

runGreetingExamples();

// Extended examples
const discount = calculateDiscount(200, 15);
console.log(discount);

const total = sumNumbers([1, 2, 3, 4, 5]);
console.log(total);
