namespace CSharpSample.SubFolder
{
    public class RedHerring
    {
        private string greeting;

        public RedHerring(string greeting)
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

        // Add a unique method specifically for testing the red herring scenario
        public void UnusedRedHerringMethod()
        {
            // This method is intentionally unused.
            Console.WriteLine("This should not appear in any impact analysis.");
        }
    }
}
