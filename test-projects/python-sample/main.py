from greeter import greet, Greeter, calculate_discount, ArrayProcessor

def run_greeting_examples():
  message1 = greet("World")
  print(message1)

  greeter_instance = Greeter("Hi")
  message2 = greeter_instance.greet_person("Alice")
  print(message2)

run_greeting_examples()

# Extended calls
message3 = calculate_discount(200, 15)
print(message3)

result = ArrayProcessor.sum_numbers([1, 2, 3, 4, 5])
print(result)
