export async function fetchAndCombineJsonFiles() {
    try {
        const response = await fetch('https://data.adj.news/data/raw');
        const data = await response.text();
        const fileLines = data.split('\n');
        const filteredFiles = fileLines
        .filter(line => line.includes('"path"'))
        .map(line => {
            const pathStartIndex = line.indexOf('"path":"') + 8;
            const pathEndIndex = line.indexOf('"', pathStartIndex);
            const filePath = `https://data.adj.news/${line.substring(pathStartIndex, pathEndIndex)}`;

            if (filePath.endsWith('.zip')) {
                return;
            }

            return fetch(filePath)
            .then(response => response.json())
            .catch(error => console.error('Error fetching JSON file:', error));
        });

        const jsonFiles = await Promise.all(filteredFiles);

        const combinedJson = [];
        jsonFiles.forEach(json => {
            if (json) {
                combinedJson.push(...json);
            }
        });
        
        return combinedJson;
    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

// async function queryModel(model, input) {
//     const response = await fetch(
//       `https://api.cloudflare.com/client/v4/accounts/e97e3b873befcbbb5a1fc8bbbce0a966/ai/run/${model}`,
//       {
//         headers: { Authorization: "Bearer 8mKLGZ8CEMHSgxS0FMrf2pOd4RTwIYPOrCUUpOWo" },
//         method: "POST",
//         body: JSON.stringify(input),
//       }
//     );
//     const result = await response.json();
//     return result;
// }
