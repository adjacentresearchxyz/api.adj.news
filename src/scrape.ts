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