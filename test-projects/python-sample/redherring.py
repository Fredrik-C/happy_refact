def greet(name):
  return f"Hello, {name}!"

class Redherring:
  def __init__(self, greeting):
    self.greeting = greeting

  def greet_person(self, name):
    return f"{self.greeting}, {name}!"

# Additional functions for discount and sum
def calculate_discount(amount: int, percent: int) -> float:
  return amount * (percent / 100)

class ArrayProcessor:
  @staticmethod
  def sum_numbers(numbers: list[int]) -> int:
    return sum(numbers)
