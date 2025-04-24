using System;
using System.Collections.Generic;

namespace CSharpSample
{
    class Program
    {
        static void Main(string[] args)
        {
            Greeter greeterInstance = new Greeter("Hello");
            string message = greeterInstance.GreetPerson("Bob");
            Console.WriteLine(message);

            // Extended tests
            decimal discount = greeterInstance.CalculateDiscount(200m, 15);
            Console.WriteLine(discount);

            var range = Greeter.GenerateRange(1, 5);
            Console.WriteLine(string.Join(",", range));
        }
    }
}
