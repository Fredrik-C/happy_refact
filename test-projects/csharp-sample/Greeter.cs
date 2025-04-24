namespace CSharpSample
{
    public class Greeter
    {
        private string greeting;

        public Greeter(string greeting)
        {
            this.greeting = greeting;
        }

        public string GreetPerson(string name)
        {
            return $"{greeting}, {name}!";
        }

        public decimal CalculateDiscount(decimal amount, int percent)
        {
            return amount * percent / 100;
        }

        public static List<int> GenerateRange(int start, int end)
        {
            var list = new List<int>();
            for (int i = start; i <= end; i++)
            {
                list.Add(i);
            }
            return list;
        }
    }
}
